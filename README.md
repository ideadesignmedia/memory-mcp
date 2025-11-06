# @ideadesignmedia/memory-mcp

SQLite-backed memory for MCP agents. Ships a CLI and programmatic API.

Highlights (v2)
- Single global memory space; no owner segregation nor types.
- Minimal schema: subject, content, date_created, date_updated, expires_at (embedding is internal-only).
- Optional FTS5 indexing for better search; falls back to `LIKE` when unavailable.
- Auto-generates embeddings internally via OpenAI when a key is provided; otherwise relies on text search. Embeddings are never accepted from nor returned to MCP clients.

## Install / Run

Quick run (no install):
```sh
npx -y @ideadesignmedia/memory-mcp --db=/abs/path/memory.db --topk=6
```

Install locally (dev dependency) and run:
```sh
npm i -D @ideadesignmedia/memory-mcp
npx memory-mcp --db=/abs/path/memory.db --topk=6
```

Other ecosystem equivalents:
- pnpm: `pnpm dlx @ideadesignmedia/memory-mcp --db=... --topk=6`
- yarn (classic): `yarn dlx @ideadesignmedia/memory-mcp --db=... --topk=6`

## CLI usage
You can invoke it directly (if globally installed) or via npx as shown above.

Optional flags:
- `--embed-key=sk-...` supply the embedding API key (same as `MEMORY_EMBEDDING_KEY`).
- `--embed-model=text-embedding-3-small` override the embedding model (same as `MEMORY_EMBED_MODEL`).

## Codex config example
Using npx so no global install is required. Add to `~/.codex/config.toml`:
```toml
[mcp_servers.memory]
command = "npx"
args = ["-y", "@ideadesignmedia/memory-mcp", "--db=/abs/path/memory.db", "--topk=6"]
```

## Programmatic API
```ts
import { MemoryStore, runStdioServer } from "@ideadesignmedia/memory-mcp";

const store = new MemoryStore("./memory.db");
// All store methods are async
const id = await store.insert({
  ownerId: "user-123",
  type: "preference",
  subject: "favorite color",
  content: "blue",
});

// Run as an MCP server over stdio
await runStdioServer({
  dbPath: "./memory.db",
  defaultTopK: 6,
  embeddingApiKey: process.env.MEMORY_EMBEDDING_KEY, // optional
});
```

## Tools (v2)

- memory-create
  - Create a memory with `subject`, `content`. Optionally include `ttlDays` (to compute `expires_at`).
  - Response: `{ ok: true }` on success, or `{ ok: false, error: string }` on failure.

- memory-search
  - Search globally by text with optional `k` (semantic ranking used internally when available).
  - Response items: `{ id, subject, content }`.

- memory-update
  - Update fields of a memory by `id`: `subject`, `content`, `ttlDays` (recomputes `expires_at`), or `expiresAt`.
  - Response: `{ ok: true }` on success, or `{ ok: false, error: string }` on failure.

- memory-delete
  - Delete a memory by `id`.
  - Response: `{ ok: true }` on success, or `{ ok: false, error: string }` on failure.

- memory-get
  - Fetch a single memory by `id`.
  - Response item: `{ id, subject, content, dateCreated, dateUpdated }`.

## Embeddings
Embeddings are optional—without a key the server relies on text search. Embeddings are internal only; they are never accepted from or returned to clients.

Set `MEMORY_EMBEDDING_KEY` (or pass `--embed-key=...` to the CLI) to automatically create embeddings when remembering/importing memories and to embed recall queries. The default model is `text-embedding-3-small`; override it with `MEMORY_EMBED_MODEL` or `--embed-model`. To disable the built-in generator when using the programmatic API, pass `embeddingProvider: null` to `createMemoryMcpServer`. To specify a key programmatically, pass `embeddingApiKey: "sk-..."`.

Limits and validation (v2)
- memory-create: `subject` max 160 chars; `content` max 2000; optional `ttlDays`.
- memory-search: optional `query` max 1000; `k` up to 20.
- memory-update: accepts partial fields; `ttlDays` recomputes `expires_at`.
