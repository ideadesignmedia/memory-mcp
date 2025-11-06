import { z } from "zod";
import OpenAIModule from "@ideadesignmedia/open-ai.js";
import type { JsonRecord } from "@ideadesignmedia/open-ai.js";
import { MemoryStore } from "./store.js";
import { logErr } from "./util.js";
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

const createParameters = defineObjectSchema({
  type: "object",
  properties: {
    subject: { type: "string", minLength: 1, maxLength: 160, description: "Short title for the memory (≤160 chars). Be concise and specific." },
    content: { type: "string", minLength: 1, maxLength: 2000, description: "One or two sentences describing the memory. Avoid secrets and ephemeral data." },
    ttlDays: { type: "number", description: "Optional retention in days (number or numeric string). Server computes expires_at from this value." },
  },
  required: ["subject", "content"],
  additionalProperties: false,
} as const);

const searchParameters = defineObjectSchema({
  type: "object",
  properties: {
    query: { type: "string", maxLength: 1000, description: "Natural-language search string. Use to find relevant memories and IDs." },
    k: { type: "number", minimum: 1, maximum: 20, description: "Max items to return (default set by server)." },
  },
  additionalProperties: false,
} as const);

const updateParameters = defineObjectSchema({
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, description: "ID of the memory to update. Find via memory-search first." },
    subject: { type: "string", minLength: 1, maxLength: 160, description: "New short title. Omit if unchanged." },
    content: { type: "string", minLength: 1, maxLength: 2000, description: "New content text. Omit if unchanged." },
    ttlDays: { type: "number", description: "Recompute expires_at by adding these days from now (number or numeric string)." },
    expiresAt: { type: "string", description: "Set an explicit ISO-8601 timestamp for expiration." },
  },
  required: ["id"],
  additionalProperties: false,
} as const);

const deleteParameters = defineObjectSchema({
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, description: "ID of the memory to delete. Use memory-search to locate it first." },
  },
  required: ["id"],
  additionalProperties: false,
} as const);

// no export/import tools in v2 minimal API

const createInputSchema = z.object({
  subject: z.string().min(1).max(160),
  content: z.string().min(1).max(2000),
  ttlDays: z.union([z.number(), z.string()]).optional(),
});

const searchInputSchema = z.object({
  query: z.string().max(1000).optional(),
  k: z.union([z.number().int().positive().max(20), z.string()]).optional(),
});

const updateInputSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1).max(160).optional(),
  content: z.string().min(1).max(2000).optional(),
  ttlDays: z.union([z.number(), z.string()]).optional(),
  expiresAt: z.string().optional(),
});

const deleteInputSchema = z.object({ id: z.string().min(1) });

const createTool = defineFunctionTool({
  type: "function",
  function: {
    name: "memory-create",
    description: "Persist a concise, reusable memory. Provide a short subject and one–two sentence content. Optionally set ttlDays to control retention. Do not store secrets or ephemeral state. Returns { id, subject, content }.\nExample: {\"subject\":\"favorite color\",\"content\":\"blue\",\"ttlDays\":30}",
    parameters: createParameters,
  },
} as const);

const searchTool = defineFunctionTool({
  type: "function",
  function: {
    name: "memory-search",
    description: "Find relevant memories and IDs by natural-language search. Use this before update/delete to locate the correct item. Returns up to k items as { id, subject, content }.\nExample: {\"query\":\"favorite color\",\"k\":6}",
    parameters: searchParameters,
  },
} as const);

const updateTool = defineFunctionTool({
  type: "function",
  function: {
    name: "memory-update",
    description: "Modify an existing memory by id. Provide only fields that change (subject/content). To extend retention, pass ttlDays or set an explicit expiresAt. Use memory-search first to confirm the id.\nExample: {\"id\":\"mem_123\",\"content\":\"blue (specifically navy)\",\"ttlDays\":60}",
    parameters: updateParameters,
  },
} as const);

const deleteTool = defineFunctionTool({
  type: "function",
  function: {
    name: "memory-delete",
    description: "Permanently delete a memory by id. Use memory-search first to confirm the exact item to remove.\nExample: {\"id\":\"mem_123\"}",
    parameters: deleteParameters,
  },
} as const);

// v2: export/import tools removed from the minimal surface

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

function serializeMemoryItem(item: { id: string; subject: string; content: string }): JsonRecord {
  return { id: item.id, subject: truncate(item.subject, 160), content: truncate(item.content, 280) } as const;
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
    tool: createTool,
    async handler(rawArgs) {
      const args = createInputSchema.parse(rawArgs);
      await store.cleanupExpired();
      const ttl = typeof args.ttlDays === 'string' ? parseInt(args.ttlDays, 10) : args.ttlDays;
      const ttlDays = Number.isFinite(ttl as number) ? (ttl as number) : undefined;
      const autoEmbedding = await tryEmbedDocument(embeddingProvider, memoryToEmbeddingText(args.subject, args.content));
      const id = await store.insert({ subject: args.subject, content: args.content, ttlDays, embedding: autoEmbedding });
      const saved = await store.get(id);
      const lite: JsonRecord = saved ? { id: saved.id, subject: saved.subject, content: saved.content } : { id } as any;
      return { id, item: lite, content: [{ type: "text", text: JSON.stringify(lite, null, 2) }] } as JsonRecord;
    },
  });

  server.registerTool({
    tool: searchTool,
    async handler(rawArgs) {
      const { query, k } = searchInputSchema.parse(rawArgs);
      await store.cleanupExpired();
      const qEmbedding = query ? await tryEmbedQuery(embeddingProvider, query) : undefined;
      const items = await store.search(query, Number(k ?? defaultTopK), qEmbedding);
      const serialized = items.map(serializeMemoryItem);
      return { items: serialized, content: [{ type: "text", text: JSON.stringify(serialized, null, 2) }] } as JsonRecord;
    },
  });

  server.registerTool({
    tool: updateTool,
    async handler(rawArgs) {
      const { id, subject, content, ttlDays, expiresAt } = updateInputSchema.parse(rawArgs);
      const ttlParsed = typeof ttlDays === 'string' ? parseInt(ttlDays, 10) : ttlDays;
      const patch: any = { subject, content, ttlDays: Number.isFinite(ttlParsed as number) ? (ttlParsed as number) : undefined, expiresAt };
      if (typeof subject === 'string' || typeof content === 'string') {
        const current = await store.get(id);
        const nextSub = typeof subject === 'string' ? subject : current?.subject ?? '';
        const nextCon = typeof content === 'string' ? content : current?.content ?? '';
        patch.embedding = await tryEmbedDocument(embeddingProvider, memoryToEmbeddingText(nextSub, nextCon));
      }
      await store.update(id, patch);
      const saved = await store.get(id);
      const lite: JsonRecord = saved ? { id: saved.id, subject: saved.subject, content: saved.content } : { id } as any;
      return { id, item: lite, content: [{ type: "text", text: JSON.stringify(lite, null, 2) }] } as JsonRecord;
    },
  });

  server.registerTool({
    tool: deleteTool,
    async handler(rawArgs) {
      const { id } = deleteInputSchema.parse(rawArgs);
      await store.delete(id);
      return { ok: true, content: [{ type: "text", text: "true" }] } as JsonRecord;
    },
  });

  // v2 minimal: no export/import handlers

  return server;
}

export async function runStdioServer(opts: ServerOptions) {
  const server = createMemoryMcpServer(opts);
  await server.start();
}
