import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryStore } from "./store.js";
import { MemoryItem } from "./types.js";
import { recencyDecay, logErr, cosineSimilarity } from "./util.js";
import { EmbeddingProvider, createDefaultEmbeddingProvider, createOpenAiEmbeddingProvider } from "./embeddings.js";

export type ServerOptions = {
  dbPath: string;
  defaultTopK?: number;
  embeddingProvider?: EmbeddingProvider | null;
  embeddingApiKey?: string | null;
  embeddingModel?: string | null;
};

const MAX_EMBEDDING_SIZE = 4096;

function sanitizeEmbeddingInput(vec?: number[]): number[] | undefined {
  if (!Array.isArray(vec)) return undefined;
  const cleaned: number[] = [];
  for (const value of vec) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    cleaned.push(value);
    if (cleaned.length >= MAX_EMBEDDING_SIZE) break;
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

async function tryEmbedDocument(provider: EmbeddingProvider | undefined, text: string) {
  if (!provider) return undefined;
  try {
    return await provider.embedDocument(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr("warn: embedding document failed:", msg);
    return undefined;
  }
}

async function tryEmbedQuery(provider: EmbeddingProvider | undefined, text: string) {
  if (!provider) return undefined;
  try {
    return await provider.embedQuery(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr("warn: embedding query failed:", msg);
    return undefined;
  }
}

function memoryToEmbeddingText(subject: string, content: string) {
  return `${subject}\n\n${content}`.trim();
}

export function createMemoryMcpServer({
  dbPath,
  defaultTopK = 6,
  embeddingProvider: providedEmbeddingProvider,
  embeddingApiKey,
  embeddingModel,
}: ServerOptions) {
  const store = new MemoryStore(dbPath);
  const server = new McpServer({ name: "memory-mcp", version: "0.1.0" });
  const resolvedKey = embeddingApiKey ?? process.env.MEMORY_EMBEDDING_KEY ?? undefined;
  const embeddingProvider =
    providedEmbeddingProvider === null
      ? undefined
      : providedEmbeddingProvider ??
        (resolvedKey
          ? createOpenAiEmbeddingProvider({ apiKey: resolvedKey, model: embeddingModel ?? undefined })
          : createDefaultEmbeddingProvider());

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
        sensitivity: z.array(z.string()).max(32).optional(),
        embedding: z.array(z.number()).min(1).max(4096).optional()
      },
      outputSchema: { id: z.string() }
    },
    async (args) => {
      await store.cleanupExpired(args.ownerId);
      const providedEmbedding = sanitizeEmbeddingInput(args.embedding);
      const autoEmbedding =
        providedEmbedding ??
        (await tryEmbedDocument(embeddingProvider, memoryToEmbeddingText(args.subject, args.content)));
      const id = await store.insert({ ...args, embedding: autoEmbedding });
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
        k: z.number().int().positive().max(20).optional(),
        embedding: z.array(z.number()).min(1).max(4096).optional()
      },
      outputSchema: { items: z.array(z.any()) }
    },
    async ({ ownerId, query, slot, k, embedding }) => {
      await store.cleanupExpired(ownerId);
      const topk = k ?? defaultTopK;
      const trimmedQuery = query?.trim() ?? "";
      const hasQuery = trimmedQuery.length > 0;

      let queryEmbedding = sanitizeEmbeddingInput(embedding);
      if (!queryEmbedding && hasQuery) {
        queryEmbedding = await tryEmbedQuery(embeddingProvider, trimmedQuery);
      }

      const candidateRequestSize = Math.max(topk * 4, 50);

      const candidates = new Map<string, MemoryItem>();
      const textMatches = new Set<string>();

      if (hasQuery) {
        const textCandidates = await store.search(ownerId, trimmedQuery, slot, candidateRequestSize, queryEmbedding);
        for (const item of textCandidates) {
          candidates.set(item.id, item);
          textMatches.add(item.id);
        }
      }

      if (queryEmbedding) {
        const embedCandidates = await store.search(ownerId, undefined, slot, candidateRequestSize, queryEmbedding);
        for (const item of embedCandidates) {
          candidates.set(item.id, item);
        }
      }

      if (!hasQuery && !queryEmbedding) {
        const fallback = await store.list(ownerId, slot, Math.max(50, topk * 10));
        for (const item of fallback) {
          candidates.set(item.id, item);
        }
      }

      const candidateList = Array.from(candidates.values());

      const baseTextWeight = hasQuery ? (queryEmbedding ? 0.4 : 0.55) : 0;
      const baseEmbedWeight = queryEmbedding ? (hasQuery ? 0.35 : 0.6) : 0;
      const baseRecWeight = 0.15;
      const baseImportanceWeight = 0.1;
      const weightSum = baseTextWeight + baseEmbedWeight + baseRecWeight + baseImportanceWeight || 1;

      const scored = candidateList
        .map((m) => {
          const textScore = hasQuery ? (textMatches.has(m.id) ? 1 : 0.3) : 0.5;
          const embedScore = queryEmbedding && m.embedding ? Math.max(cosineSimilarity(queryEmbedding, m.embedding), 0) : 0;
          const rec = recencyDecay(m.lastUsedAt);
          const imp = m.importance ?? 0.5;
          const raw =
            textScore * baseTextWeight +
            embedScore * baseEmbedWeight +
            rec * baseRecWeight +
            imp * baseImportanceWeight;
          const score = raw / weightSum;
          return { m, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topk)
        .map(({ m }) => m);

      for (const m of scored) {
        try {
          await store.bumpUse(m.id);
        } catch {
          // ignored
        }
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
          sensitivity: z.array(z.string()).max(32).optional(),
          embedding: z.array(z.number()).min(1).max(4096).optional()
        })).max(1000)
      },
      outputSchema: { ok: z.boolean() }
    },
    async ({ ownerId, items }) => {
      if (items.length > 1000) {
        throw new Error("Too many items: max 1000");
      }
      const prepared = [];
      for (const item of items) {
        const providedEmbedding = sanitizeEmbeddingInput((item as any).embedding);
        const embeddingVector =
          providedEmbedding ??
          (await tryEmbedDocument(embeddingProvider, memoryToEmbeddingText(item.subject, item.content)));
        prepared.push({ ...item, embedding: embeddingVector });
      }
      await store.import(ownerId, prepared as any);
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
