import OpenAI from "openai";
import { logErr } from "./util.js";

export interface EmbeddingProvider {
  embedDocument(text: string): Promise<number[]>;
  embedQuery(text: string): Promise<number[]>;
}

export type OpenAiEmbeddingOptions = {
  apiKey?: string;
  model?: string;
  baseURL?: string;
};

function extractVector(result: { data?: Array<{ embedding?: number[] }> }, context: string): number[] {
  const vector = result?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`No embedding returned for ${context}`);
  }
  return vector;
}

export function createOpenAiEmbeddingProvider(opts: OpenAiEmbeddingOptions = {}): EmbeddingProvider {
  const apiKey = opts.apiKey || process.env.MEMORY_EMBEDDING_KEY;
  if (!apiKey) throw new Error("Missing embedding API key. Set MEMORY_EMBEDDING_KEY.");
  const client = new OpenAI({
    apiKey,
    baseURL: opts.baseURL || process.env.MEMORY_EMBEDDING_BASE_URL,
  });
  const model = opts.model || process.env.MEMORY_EMBED_MODEL || "text-embedding-3-small";

  return {
    async embedDocument(text: string) {
      const res = await client.embeddings.create({ model, input: text });
      return extractVector(res, "document");
    },
    async embedQuery(text: string) {
      const res = await client.embeddings.create({ model, input: text });
      return extractVector(res, "query");
    },
  };
}

export function createDefaultEmbeddingProvider(): EmbeddingProvider | undefined {
  try {
    return createOpenAiEmbeddingProvider();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr("info: embedding provider disabled:", msg);
    return undefined;
  }
}
