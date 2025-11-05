import { z } from "zod";
import OpenAIModule from "@ideadesignmedia/open-ai.js";
import type { JsonRecord } from "@ideadesignmedia/open-ai.js";
import { MemoryStore } from "./store.js";
import { MemoryItem, MemoryType } from "./types.js";
import { recencyDecay, logErr, cosineSimilarity } from "./util.js";
import {
  EmbeddingProvider,
  createDefaultEmbeddingProvider,
  createOpenAiEmbeddingProvider,
} from "./embeddings.js";

const { McpServer, defineFunctionTool, defineObjectSchema } =
  OpenAIModule as unknown as typeof import("@ideadesignmedia/open-ai.js");

export type ServerOptions = {
  dbPath: string;
  defaultTopK?: number;
  embeddingProvider?: EmbeddingProvider | null;
  embeddingApiKey?: string | null;
  embeddingModel?: string | null;
};

const MAX_EMBEDDING_SIZE = 4096;
const memoryTypeValues = ["preference", "profile", "project", "fact", "constraint"] as const;

const rememberParameters = defineObjectSchema({
  type: "object",
  properties: {
    ownerId: { type: "string", minLength: 1 },
    type: { type: "string", enum: [...memoryTypeValues] },
    subject: { type: "string", minLength: 1, maxLength: 160 },
    content: { type: "string", minLength: 1, maxLength: 1000 },
    importance: { type: "number", minimum: 0, maximum: 1 },
    ttlDays: { type: "integer", minimum: 1 },
    pinned: { type: "boolean" },
    consent: { type: "boolean" },
    sensitivity: {
      type: "array",
      items: { type: "string" },
      maxItems: 32,
    },
    embedding: {
      type: "array",
      items: { type: "number" },
      minItems: 1,
      maxItems: MAX_EMBEDDING_SIZE,
    },
  },
  required: ["ownerId", "type", "subject", "content"],
  additionalProperties: false,
} as const);

const recallParameters = defineObjectSchema({
  type: "object",
  properties: {
    ownerId: { type: "string", minLength: 1 },
    query: { type: "string", maxLength: 1000 },
    slot: { type: "string", enum: [...memoryTypeValues] },
    k: { type: "integer", minimum: 1, maximum: 20 },
    embedding: {
      type: "array",
      items: { type: "number" },
      minItems: 1,
      maxItems: MAX_EMBEDDING_SIZE,
    },
  },
  required: ["ownerId"],
  additionalProperties: false,
} as const);

const listParameters = defineObjectSchema({
  type: "object",
  properties: {
    ownerId: { type: "string", minLength: 1 },
    slot: { type: "string", enum: [...memoryTypeValues] },
  },
  required: ["ownerId"],
  additionalProperties: false,
} as const);

const forgetParameters = defineObjectSchema({
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
  },
  required: ["id"],
  additionalProperties: false,
} as const);

const exportParameters = defineObjectSchema({
  type: "object",
  properties: {
    ownerId: { type: "string", minLength: 1 },
  },
  required: ["ownerId"],
  additionalProperties: false,
} as const);

const importItemSchema = defineObjectSchema({
  type: "object",
  properties: {
    type: { type: "string", enum: [...memoryTypeValues] },
    subject: { type: "string", minLength: 1, maxLength: 160 },
    content: { type: "string", minLength: 1, maxLength: 1000 },
    importance: { type: "number", minimum: 0, maximum: 1 },
    useCount: { type: "integer", minimum: 0 },
    lastUsedAt: { type: "string" },
    expiresAt: { type: "string" },
    pinned: { type: "boolean" },
    consent: { type: "boolean" },
    sensitivity: {
      type: "array",
      items: { type: "string" },
      maxItems: 32,
    },
    embedding: {
      type: "array",
      items: { type: "number" },
      minItems: 1,
      maxItems: MAX_EMBEDDING_SIZE,
    },
  },
  required: ["type", "subject", "content"],
  additionalProperties: false,
} as const);

const importParameters = defineObjectSchema({
  type: "object",
  properties: {
    ownerId: { type: "string", minLength: 1 },
    items: {
      type: "array",
      items: importItemSchema,
      maxItems: 1000,
    },
  },
  required: ["ownerId", "items"],
  additionalProperties: false,
} as const);

const rememberInputSchema = z.object({
  ownerId: z.string().min(1),
  type: z.enum(memoryTypeValues),
  subject: z.string().min(1).max(160),
  content: z.string().min(1).max(1000),
  importance: z.number().min(0).max(1).optional(),
  ttlDays: z.number().int().positive().optional(),
  pinned: z.boolean().optional(),
  consent: z.boolean().optional(),
  sensitivity: z.array(z.string()).max(32).optional(),
  embedding: z.array(z.number()).min(1).max(MAX_EMBEDDING_SIZE).optional(),
});

const recallInputSchema = z.object({
  ownerId: z.string().min(1),
  query: z.string().max(1000).optional(),
  slot: z.enum(memoryTypeValues).optional(),
  k: z.number().int().positive().max(20).optional(),
  embedding: z.array(z.number()).min(1).max(MAX_EMBEDDING_SIZE).optional(),
});

const listInputSchema = z.object({
  ownerId: z.string().min(1),
  slot: z.enum(memoryTypeValues).optional(),
});

const forgetInputSchema = z.object({
  id: z.string().min(1),
});

const importItemInputSchema = z.object({
  type: z.enum(memoryTypeValues),
  subject: z.string().min(1).max(160),
  content: z.string().min(1).max(1000),
  importance: z.number().min(0).max(1).optional(),
  useCount: z.number().int().min(0).optional(),
  lastUsedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  pinned: z.boolean().optional(),
  consent: z.boolean().optional(),
  sensitivity: z.array(z.string()).max(32).optional(),
  embedding: z.array(z.number()).min(1).max(MAX_EMBEDDING_SIZE).optional(),
});

const exportInputSchema = z.object({
  ownerId: z.string().min(1),
});

const importInputSchema = z.object({
  ownerId: z.string().min(1),
  items: z.array(importItemInputSchema).max(1000),
});

const rememberTool = defineFunctionTool({
  type: "function",
  function: {
    name: "memory-remember",
    description:
      "Create a concise memory for an owner. Provide a type (slot), short subject and content. Optionally include importance (0-1), ttlDays, pinned, consent, sensitivity tags, and an embedding. Response is minimal: { id, type, subject, content } (no embeddings or extra metadata).",
    parameters: rememberParameters,
  },
} as const);

const recallTool = defineFunctionTool({
  type: "function",
  function: {
    name: "memory-recall",
    description:
      "Retrieve up to k relevant memories for an owner by semantic/text search. Provide optional natural-language query and/or embedding, and an optional type (slot). Returns ranked items with subject, content, importance, recency, and id.",
    parameters: recallParameters,
  },
} as const);

const listTool = defineFunctionTool({
  type: "function",
  function: {
    name: "memory-list",
    description:
      "List recent memories for an owner, optionally filtered by type (slot). Useful when you want the full set without search.",
    parameters: listParameters,
  },
} as const);

const forgetTool = defineFunctionTool({
  type: "function",
  function: {
    name: "memory-forget",
    description:
      "Delete a memory by id. Use after validating the item via recall/list if uncertain.",
    parameters: forgetParameters,
  },
} as const);

const exportTool = defineFunctionTool({
  type: "function",
  function: {
    name: "memory-export",
    description:
      "Export all memories for an owner as JSON array. Useful for backup, migration, or offline inspection.",
    parameters: exportParameters,
  },
} as const);

const importTool = defineFunctionTool({
  type: "function",
  function: {
    name: "memory-import",
    description:
      "Bulk import memories for an owner. Each item mirrors the memory schema (type, subject, content, metadata, optional embedding). Max 1000 items per call.",
    parameters: importParameters,
  },
} as const);

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

function truncate(text: string, max = 280): string {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

function serializeMemoryItem(item: MemoryItem): JsonRecord {
  return {
    id: item.id,
    type: item.type,
    subject: truncate(item.subject, 160),
    content: truncate(item.content, 280),
  } as const;
}

export function createMemoryMcpServer({
  dbPath,
  defaultTopK = 6,
  embeddingProvider: providedEmbeddingProvider,
  embeddingApiKey,
  embeddingModel,
}: ServerOptions) {
  const store = new MemoryStore(dbPath);
  const resolvedKey = embeddingApiKey ?? process.env.MEMORY_EMBEDDING_KEY ?? undefined;
  const embeddingProvider =
    providedEmbeddingProvider === null
      ? undefined
      : providedEmbeddingProvider ??
        (resolvedKey
          ? createOpenAiEmbeddingProvider({ apiKey: resolvedKey, model: embeddingModel ?? undefined })
          : createDefaultEmbeddingProvider());

  const server = new McpServer({
    transports: ["stdio"],
  });

  server.registerTool({
    tool: rememberTool,
    async handler(rawArgs) {
      const args = rememberInputSchema.parse(rawArgs);
      await store.cleanupExpired(args.ownerId);

      const providedEmbedding = sanitizeEmbeddingInput(args.embedding);
      const autoEmbedding =
        providedEmbedding ??
        (await tryEmbedDocument(embeddingProvider, memoryToEmbeddingText(args.subject, args.content)));

      const { embedding, ...rest } = args;
      const id = await store.insert({ ...rest, embedding: autoEmbedding });
      const saved = await store.get(id);
      const lite: JsonRecord = saved
        ? { id: saved.id, type: saved.type, subject: saved.subject, content: saved.content }
        : { id };
      return {
        id,
        item: lite,
        content: [{ type: "text", text: JSON.stringify(lite) }],
      } satisfies JsonRecord;
    },
  });

  server.registerTool({
    tool: recallTool,
    async handler(rawArgs) {
      const { ownerId, query, slot, k, embedding } = recallInputSchema.parse(rawArgs);

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
        const textCandidates = await store.search(ownerId, trimmedQuery, slot as MemoryType | undefined, candidateRequestSize, queryEmbedding);
        for (const item of textCandidates) {
          candidates.set(item.id, item);
          textMatches.add(item.id);
        }
      }

      if (queryEmbedding) {
        const embedCandidates = await store.search(ownerId, undefined, slot as MemoryType | undefined, candidateRequestSize, queryEmbedding);
        for (const item of embedCandidates) {
          candidates.set(item.id, item);
        }
      }

      if (!hasQuery && !queryEmbedding) {
        const fallback = await store.list(ownerId, slot as MemoryType | undefined, Math.max(50, topk * 10));
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

      const serialized = scored.map(serializeMemoryItem);
      return {
        items: serialized,
        content: [{ type: "text", text: JSON.stringify(serialized, null, 2) }],
      } satisfies JsonRecord;
    },
  });

  server.registerTool({
    tool: listTool,
    async handler(rawArgs) {
      const { ownerId, slot } = listInputSchema.parse(rawArgs);
      await store.cleanupExpired(ownerId);
      const items = await store.list(ownerId, slot as MemoryType | undefined);
      const serialized = items.map(serializeMemoryItem);
      return {
        items: serialized,
        content: [{ type: "text", text: JSON.stringify(serialized, null, 2) }],
      } satisfies JsonRecord;
    },
  });

  server.registerTool({
    tool: forgetTool,
    async handler(rawArgs) {
      const { id } = forgetInputSchema.parse(rawArgs);
      await store.forget(id);
      return { ok: true, content: [{ type: "text", text: "true" }] } satisfies JsonRecord;
    },
  });

  server.registerTool({
    tool: exportTool,
    async handler(rawArgs) {
      const { ownerId } = exportInputSchema.parse(rawArgs);
      const items = await store.export(ownerId);
      const serialized = items.map(serializeMemoryItem);
      return {
        items: serialized,
        content: [{ type: "text", text: JSON.stringify(serialized, null, 2) }],
      } satisfies JsonRecord;
    },
  });

  server.registerTool({
    tool: importTool,
    async handler(rawArgs) {
      const { ownerId, items } = importInputSchema.parse(rawArgs);
      if (items.length > 1000) {
        throw new Error("Too many items: max 1000");
      }

      const prepared: Array<Omit<MemoryItem, "id" | "ownerId" | "createdAt">> = [];
      for (const item of items) {
        const providedEmbedding = sanitizeEmbeddingInput(item.embedding);
        const embeddingVector =
          providedEmbedding ??
          (await tryEmbedDocument(embeddingProvider, memoryToEmbeddingText(item.subject, item.content)));

        prepared.push({
          type: item.type as MemoryType,
          subject: item.subject,
          content: item.content,
          importance: item.importance ?? 0.5,
          useCount: item.useCount ?? 0,
          lastUsedAt: item.lastUsedAt,
          expiresAt: item.expiresAt,
          pinned: item.pinned ?? false,
          consent: item.consent ?? false,
          sensitivity: item.sensitivity ?? [],
          embedding: embeddingVector,
        });
      }

      await store.import(ownerId, prepared);
      return { ok: true, content: [{ type: "text", text: "true" }] } satisfies JsonRecord;
    },
  });

  return server;
}

export async function runStdioServer(opts: ServerOptions) {
  const server = createMemoryMcpServer(opts);
  await server.start();
}
