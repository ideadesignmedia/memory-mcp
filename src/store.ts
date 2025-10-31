import sqlite3 from "sqlite3";
import { randomUUID } from "crypto";
import { MemoryItem, MemoryType } from "./types.js";
import { nowIso, logErr } from "./util.js";

export class MemoryStore {
  private db: sqlite3.Database;
  private ready: Promise<void>;

  constructor(filePath: string) {
    const sqlite = sqlite3.verbose();
    this.db = new sqlite.Database(filePath);
    this.ready = new Promise((resolve) => {
      this.db.serialize(() => {
        this.db.exec(
          `create table if not exists memories (
            id text primary key,
            owner_id text not null,
            type text not null,
            subject text not null,
            content text not null,
            importance real not null default 0.5,
            use_count integer not null default 0,
            created_at text not null,
            last_used_at text,
            expires_at text,
            pinned integer not null default 0,
            consent integer not null default 0,
            sensitivity text not null default '[]'
          );`,
          (err) => {
            if (err) logErr("fatal: migrate base table:", err.message || String(err));
            // Try to enable FTS structures; ignore if unavailable
            this.db.exec(
              `create virtual table if not exists memory_fts using fts5(
                 subject, content, content='memories', content_rowid='rowid'
               );
               create trigger if not exists memories_ai after insert on memories begin
                 insert into memory_fts(rowid, subject, content) values (new.rowid, new.subject, new.content);
               end;
               create trigger if not exists memories_au after update on memories begin
                 update memory_fts set subject = new.subject, content = new.content where rowid = new.rowid;
               end;
               create trigger if not exists memories_ad after delete on memories begin
                 delete from memory_fts where rowid = old.rowid;
               end;`,
              (ftsErr) => {
                if (ftsErr) logErr("warn: FTS5 unavailable, LIKE fallback enabled");
                resolve();
              }
            );
          }
        );
      });
    });
  }

  private run(sql: string, params: any[] = []): Promise<sqlite3.RunResult> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (this: sqlite3.RunResult, err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  }

  private all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows: T[]) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }

  async cleanupExpired(ownerId?: string) {
    await this.ready;
    const sqlWithOwner =
      "delete from memories where expires_at is not null and datetime(expires_at) <= datetime('now') and owner_id = ?";
    const sqlAll =
      "delete from memories where expires_at is not null and datetime(expires_at) <= datetime('now')";
    if (ownerId) await this.run(sqlWithOwner, [ownerId]);
    else await this.run(sqlAll);
  }

  async insert(opts: {
    ownerId: string; type: MemoryType; subject: string; content: string;
    importance?: number; ttlDays?: number; pinned?: boolean; consent?: boolean; sensitivity?: string[];
  }): Promise<string> {
    await this.ready;
    const id = randomUUID();
    const createdAt = nowIso();
    const expiresAt = opts.ttlDays ? new Date(Date.now() + opts.ttlDays * 864e5).toISOString() : null;
    await this.run(
      `insert into memories (id, owner_id, type, subject, content, importance, use_count, created_at, expires_at, pinned, consent, sensitivity)
       values (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        id,
        opts.ownerId,
        opts.type,
        opts.subject,
        opts.content,
        opts.importance ?? 0.5,
        createdAt,
        expiresAt,
        opts.pinned ? 1 : 0,
        opts.consent ? 1 : 0,
        JSON.stringify(opts.sensitivity ?? []),
      ]
    );
    return id;
  }

  async bumpUse(id: string) {
    await this.ready;
    await this.run("update memories set use_count = use_count + 1, last_used_at = ? where id = ?", [nowIso(), id]);
  }

  async forget(id: string) {
    await this.ready;
    await this.run("delete from memories where id = ?", [id]);
  }

  async list(ownerId: string, slot?: MemoryType, limit = 200): Promise<MemoryItem[]> {
    await this.ready;
    const rows = slot
      ? await this.all<any>("select * from memories where owner_id = ? and type = ? limit ?", [ownerId, slot, limit])
      : await this.all<any>("select * from memories where owner_id = ? limit ?", [ownerId, limit]);
    return rows.map((r) => this.rowToItem(r));
  }

  async export(ownerId: string): Promise<MemoryItem[]> {
    await this.ready;
    const rows = await this.all<any>("select * from memories where owner_id = ?", [ownerId]);
    return rows.map((r) => this.rowToItem(r));
  }

  async import(ownerId: string, items: Omit<MemoryItem, "ownerId" | "id" | "createdAt">[]) {
    await this.ready;
    await this.run("BEGIN IMMEDIATE");
    try {
      for (const it of items) {
        await this.run(
          `insert into memories (id, owner_id, type, subject, content, importance, use_count, created_at, last_used_at, expires_at, pinned, consent, sensitivity)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            ownerId,
            it.type,
            it.subject,
            it.content,
            it.importance ?? 0.5,
            it.useCount ?? 0,
            nowIso(),
            it.lastUsedAt ?? null,
            it.expiresAt ?? null,
            it.pinned ? 1 : 0,
            it.consent ? 1 : 0,
            JSON.stringify(it.sensitivity ?? []),
          ]
        );
      }
      await this.run("COMMIT");
    } catch (err) {
      await this.run("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  async search(ownerId: string, query: string, slot?: MemoryType, k = 8): Promise<MemoryItem[]> {
    await this.ready;
    const base = `
      select m.* from memory_fts f
      join memories m on m.rowid = f.rowid
      where m.owner_id = ? and memory_fts match ?
    `;
    const sql = slot ? `${base} and m.type = ? limit ?` : `${base} limit ?`;
    try {
      const rows = slot
        ? await this.all<any>(sql, [ownerId, query, slot, k * 4])
        : await this.all<any>(sql, [ownerId, query, k * 4]);
      return rows.map((r) => this.rowToItem(r));
    } catch {
      const esc = query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const like = `%${esc}%`;
      const sqlLike = slot
        ? `select * from memories where owner_id = ? and type = ? and (subject like ? escape '\\' or content like ? escape '\\') limit ?`
        : `select * from memories where owner_id = ? and (subject like ? escape '\\' or content like ? escape '\\') limit ?`;
      const rows = slot
        ? await this.all<any>(sqlLike, [ownerId, slot, like, like, k * 4])
        : await this.all<any>(sqlLike, [ownerId, like, like, k * 4]);
      return rows.map((r) => this.rowToItem(r));
    }
  }

  private rowToItem(row: any): MemoryItem {
    let sensitivity: string[] = [];
    try {
      sensitivity = JSON.parse(row.sensitivity ?? "[]");
      if (!Array.isArray(sensitivity)) sensitivity = [];
    } catch {
      sensitivity = [];
    }
    return {
      id: row.id,
      ownerId: row.owner_id,
      type: row.type,
      subject: row.subject,
      content: row.content,
      importance: row.importance,
      useCount: row.use_count,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      pinned: !!row.pinned,
      consent: !!row.consent,
      sensitivity,
    };
  }
}
