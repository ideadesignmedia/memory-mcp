import sqlite3 from "sqlite3";
import { randomUUID } from "crypto";
import { MemoryItem } from "./types.js";
import { nowIso, logErr, cosineSimilarity } from "./util.js";

export class MemoryStore {
  private db: sqlite3.Database;
  private ready: Promise<void>;

  constructor(filePath: string) {
    const sqlite = sqlite3.verbose();
    this.db = new sqlite.Database(filePath);
    this.ready = new Promise((resolve) => {
      this.db.serialize(() => {
        this.db.exec(
          `create table if not exists memories_v2 (
            id text primary key,
            subject text not null,
            content text not null,
            date_created text not null,
            date_updated text not null,
            expires_at text,
            embedding text
          );`,
          (err) => {
            if (err) logErr("fatal: migrate v2 table:", err.message || String(err));
            // Try to enable FTS structures; ignore if unavailable
            this.db.exec(
              `create virtual table if not exists memories_v2_fts using fts5(
                 subject, content, content='memories_v2', content_rowid='rowid'
               );
               create trigger if not exists memories_v2_ai after insert on memories_v2 begin
                 insert into memories_v2_fts(rowid, subject, content) values (new.rowid, new.subject, new.content);
               end;
               create trigger if not exists memories_v2_au after update on memories_v2 begin
                 update memories_v2_fts set subject = new.subject, content = new.content where rowid = new.rowid;
               end;
               create trigger if not exists memories_v2_ad after delete on memories_v2 begin
                 delete from memories_v2_fts where rowid = old.rowid;
               end;`,
              (ftsErr) => {
                if (ftsErr) logErr("warn: FTS5 unavailable for v2, LIKE fallback enabled");
                resolve();
              }
            );
          }
        );
      });
    });
  }

  // v2: embedding column is part of base table

  private normalizeEmbedding(vec?: number[]): number[] | undefined {
    if (!Array.isArray(vec)) return undefined;
    const cleaned: number[] = [];
    for (const value of vec) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      cleaned.push(value);
      if (cleaned.length >= 4096) break;
    }
    return cleaned.length > 0 ? cleaned : undefined;
  }

  private parseEmbedding(raw: unknown): number[] | undefined {
    if (raw === null || raw === undefined) return undefined;
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return this.normalizeEmbedding(parsed as number[]);
    } catch {
      return undefined;
    }
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

  async cleanupExpired() {
    await this.ready;
    await this.run(
      "delete from memories_v2 where expires_at is not null and datetime(expires_at) <= datetime('now')"
    );
  }

  async insert(opts: { subject: string; content: string; ttlDays?: number; embedding?: number[] }): Promise<string> {
    await this.ready;
    const id = randomUUID();
    const now = nowIso();
    const expiresAt = typeof opts.ttlDays === 'number' && Number.isFinite(opts.ttlDays)
      ? new Date(Date.now() + Math.trunc(opts.ttlDays) * 864e5).toISOString()
      : null;
    const embedding = this.normalizeEmbedding(opts.embedding);
    await this.run(
      `insert into memories_v2 (id, subject, content, date_created, date_updated, expires_at, embedding)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        opts.subject,
        opts.content,
        now,
        now,
        expiresAt,
        embedding ? JSON.stringify(embedding) : null,
      ]
    );
    return id;
  }

  async update(id: string, patch: { subject?: string; content?: string; ttlDays?: number; expiresAt?: string; embedding?: number[] }) {
    await this.ready;
    const fields: string[] = [];
    const params: any[] = [];
    if (typeof patch.subject === 'string') { fields.push('subject = ?'); params.push(patch.subject); }
    if (typeof patch.content === 'string') { fields.push('content = ?'); params.push(patch.content); }
    if (typeof patch.ttlDays !== 'undefined') {
      const newExp = typeof patch.ttlDays === 'number' && Number.isFinite(patch.ttlDays)
        ? new Date(Date.now() + Math.trunc(patch.ttlDays) * 864e5).toISOString()
        : null;
      fields.push('expires_at = ?'); params.push(newExp);
    }
    if (typeof patch.expiresAt === 'string') { fields.push('expires_at = ?'); params.push(patch.expiresAt); }
    if (Array.isArray(patch.embedding)) {
      const norm = this.normalizeEmbedding(patch.embedding);
      fields.push('embedding = ?'); params.push(norm ? JSON.stringify(norm) : null);
    }
    fields.push('date_updated = ?'); params.push(nowIso());
    if (fields.length === 0) return;
    const sql = `update memories_v2 set ${fields.join(', ')} where id = ?`;
    params.push(id);
    await this.run(sql, params);
  }

  async delete(id: string) {
    await this.ready;
    await this.run("delete from memories_v2 where id = ?", [id]);
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    await this.ready;
    const rows = await this.all<any>("select * from memories_v2 where id = ? limit 1", [id]);
    if (!rows || rows.length === 0) return undefined;
    return this.rowToItem(rows[0]);
  }

  async list(limit = 200): Promise<MemoryItem[]> {
    await this.ready;
    const rows = await this.all<any>("select * from memories_v2 order by date_updated desc limit ?", [limit]);
    return rows.map((r) => this.rowToItem(r));
  }

  async exportAll(): Promise<MemoryItem[]> {
    await this.ready;
    const rows = await this.all<any>("select * from memories_v2 order by date_created asc", []);
    return rows.map((r) => this.rowToItem(r));
  }

  async importAll(items: Array<Omit<MemoryItem, "id" | "dateCreated" | "dateUpdated">>) {
    await this.ready;
    await this.run("BEGIN IMMEDIATE");
    try {
      for (const it of items) {
        const embedding = this.normalizeEmbedding(it.embedding);
        const id = randomUUID();
        const now = nowIso();
        await this.run(
          `insert into memories_v2 (id, subject, content, date_created, date_updated, expires_at, embedding)
           values (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            it.subject,
            it.content,
            now,
            now,
            it.expiresAt ?? null,
            embedding ? JSON.stringify(embedding) : null,
          ]
        );
      }
      await this.run("COMMIT");
    } catch (err) {
      await this.run("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  async search(query?: string, k = 8, embedding?: number[]): Promise<MemoryItem[]> {
    await this.ready;
    const trimmedQuery = query?.trim() ?? "";
    const hasQuery = trimmedQuery.length > 0;
    const queryEmbedding = this.normalizeEmbedding(embedding);
    const fetchMultiplier = queryEmbedding ? 6 : 4;

    if (!hasQuery && queryEmbedding) {
      const limit = Math.max(k * fetchMultiplier, 50);
      const sqlEmbed = `select * from memories_v2 where embedding is not null order by date_updated desc limit ?`;
      const rows = await this.all<any>(sqlEmbed, [limit]);
      return rows
        .map((r) => this.rowToItem(r))
        .map((item) => ({ item, sim: cosineSimilarity(queryEmbedding, item.embedding) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k)
        .map(({ item }) => item);
    }

    if (!hasQuery) return this.list(Math.max(50, k * fetchMultiplier));

    const base = `
      select m.* from memories_v2_fts f
      join memories_v2 m on m.rowid = f.rowid
      where memories_v2_fts match ?
    `;
    const sql = `${base} limit ?`;
    try {
      const rows = await this.all<any>(sql, [trimmedQuery, k * fetchMultiplier]);
      const items = rows.map((r) => this.rowToItem(r));
      if (!queryEmbedding) return items;
      return items
        .map((item) => ({ item, sim: cosineSimilarity(queryEmbedding, item.embedding) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k)
        .map(({ item }) => item);
    } catch {
      const esc = trimmedQuery.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const like = `%${esc}%`;
      const sqlLike = `select * from memories_v2 where (subject like ? escape '\\' or content like ? escape '\\') order by date_updated desc limit ?`;
      const rows = await this.all<any>(sqlLike, [like, like, k * fetchMultiplier]);
      const items = rows.map((r) => this.rowToItem(r));
      if (!queryEmbedding) return items;
      return items
        .map((item) => ({ item, sim: cosineSimilarity(queryEmbedding, item.embedding) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k)
        .map(({ item }) => item);
    }
  }

  private rowToItem(row: any): MemoryItem {
    const embedding = this.parseEmbedding(row.embedding);
    return {
      id: row.id,
      subject: row.subject,
      content: row.content,
      dateCreated: row.date_created,
      dateUpdated: row.date_updated,
      expiresAt: row.expires_at ?? undefined,
      embedding,
    };
  }
}
