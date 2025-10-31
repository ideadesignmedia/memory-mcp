import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryStore } from "./store.js";
import { MemoryItem } from "./types.js";
import { recencyDecay, logErr } from "./util.js";

export type ServerOptions = {
  dbPath: string;
  defaultTopK?: number;
};

export function createMemoryMcpServer({ dbPath, defaultTopK = 6 }: ServerOptions) {
  const store = new MemoryStore(dbPath);
  const server = new McpServer({ name: "memory-mcp", version: "0.1.0" });

  server.registerTool(
    "memory.remember",
    {
      title: "Remember a fact",
      description: "Store a small, high-value fact with optional TTL",
      inputSchema: {
        ownerId: z.string(),
        type: z.enum(["preference", "profile", "project", "fact", "constraint"]),
        subject: z.string().min(1).max(160),
        content: z.string().min(1).max(1000),
        importance: z.number().min(0).max(1).optional(),
        ttlDays: z.number().int().positive().optional(),
        pinned: z.boolean().optional(),
        consent: z.boolean().optional(),
        sensitivity: z.array(z.string()).max(32).optional()
      },
      outputSchema: { id: z.string() }
    },
    async (args) => {
      await store.cleanupExpired(args.ownerId);
      const id = await store.insert(args);
      return { structuredContent: { id }, content: [{ type: "text", text: id }] };
    }
  );

  server.registerTool(
    "memory.recall",
    {
      title: "Recall facts",
      description: "Retrieve up to k relevant memory items",
      inputSchema: {
        ownerId: z.string(),
        query: z.string().max(1000).optional(),
        slot: z.enum(["preference", "profile", "project", "fact", "constraint"]).optional(),
        k: z.number().int().positive().max(20).optional()
      },
      outputSchema: { items: z.array(z.any()) }
    },
    async ({ ownerId, query, slot, k }) => {
      await store.cleanupExpired(ownerId);
      const topk = k ?? defaultTopK;

      let candidates: MemoryItem[];
      if (query && query.trim().length > 0) {
        candidates = await store.search(ownerId, query, slot, topk);
      } else {
        // Limit scan size when no query to avoid large in-memory sorts
        candidates = await store.list(ownerId, slot, Math.max(50, topk * 10));
      }

      const scored = candidates
        .map(m => {
          const sim = query ? 0.55 : 0.5;
          const rec = recencyDecay(m.lastUsedAt);
          const score = 0.55 * sim + 0.25 * rec + 0.2 * (m.importance ?? 0.5);
          return { m, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topk)
        .map(({ m }) => m);

      for (const m of scored) {
        try { await store.bumpUse(m.id); } catch {}
      }

      return { structuredContent: { items: scored }, content: [{ type: "text", text: JSON.stringify(scored, null, 2) }] };
    }
  );

  server.registerTool(
    "memory.list",
    {
      title: "List all",
      description: "List memories for an owner, optionally by slot",
      inputSchema: { ownerId: z.string(), slot: z.enum(["preference","profile","project","fact","constraint"]).optional() },
      outputSchema: { items: z.array(z.any()) }
    },
    async ({ ownerId, slot }) => {
      await store.cleanupExpired(ownerId);
      const items = await store.list(ownerId, slot);
      return { structuredContent: { items }, content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );

  server.registerTool(
    "memory.forget",
    {
      title: "Forget one",
      description: "Delete a memory by id",
      inputSchema: { id: z.string() },
      outputSchema: { ok: z.boolean() }
    },
    async ({ id }) => {
      await store.forget(id);
      return { structuredContent: { ok: true }, content: [{ type: "text", text: "true" }] };
    }
  );

  server.registerTool(
    "memory.export",
    {
      title: "Export all for owner",
      description: "Export memory items as JSON",
      inputSchema: { ownerId: z.string() },
      outputSchema: { items: z.array(z.any()) }
    },
    async ({ ownerId }) => {
      const items = await store.export(ownerId);
      return { structuredContent: { items }, content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );

  server.registerTool(
    "memory.import",
    {
      title: "Import items",
      description: "Bulk import memory items for an owner",
      inputSchema: {
        ownerId: z.string(),
        items: z.array(z.object({
          type: z.enum(["preference","profile","project","fact","constraint"]),
          subject: z.string().min(1).max(160),
          content: z.string().min(1).max(1000),
          importance: z.number().min(0).max(1).optional(),
          useCount: z.number().int().min(0).optional(),
          lastUsedAt: z.string().optional(),
          expiresAt: z.string().optional(),
          pinned: z.boolean().optional(),
          consent: z.boolean().optional(),
          sensitivity: z.array(z.string()).max(32).optional()
        })).max(1000)
      },
      outputSchema: { ok: z.boolean() }
    },
    async ({ ownerId, items }) => {
      if (items.length > 1000) {
        throw new Error("Too many items: max 1000");
      }
      await store.import(ownerId, items as any);
      return { structuredContent: { ok: true }, content: [{ type: "text", text: "true" }] };
    }
  );

  return server;
}

export async function runStdioServer(opts: ServerOptions) {
  const server = createMemoryMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
