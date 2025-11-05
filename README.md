# @ideadesignmedia/memory-mcp

SQLite-backed memory for MCP agents. Ships a CLI and programmatic API.

Highlights
- Uses `sqlite3` (async) for broad prebuilt support; no brittle native build steps.
- Optional FTS5 indexing for better search; falls back to `LIKE` when unavailable.
- Input validation and sane limits to guard against oversized payloads.
- Auto-generates semantic embeddings via OpenAI when a key is provided; otherwise falls back to text-only scoring.

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

## Tools

All tools are safe for STDIO. The server writes logs to stderr only.

- memory-remember
  - Create a concise memory for an owner. Provide `ownerId`, `type` (slot), short `subject`, and `content`. Optionally set `importance` (0–1), `ttlDays`, `pinned`, `consent`, `sensitivity` (tags), and `embedding`.
  - Response is minimal for LLMs (no embeddings or extra metadata):
    ```json
    {
      "id": "mem_...",
      "item": { "id": "mem_...", "type": "preference", "subject": "favorite color", "content": "blue" },
      "content": [ { "type": "text", "text": "{\"id\":\"mem_...\",\"type\":\"preference\",\"subject\":\"favorite color\",\"content\":\"blue\"}" } ]
    }
    ```

- memory-recall
  - Retrieve up to `k` relevant memories for an owner via text/semantic search. Accepts optional natural-language `query`, optional `embedding`, and optional `slot` (type).
  - Response is minimal per item: `{ id, type, subject, content }`.

- memory-list
  - List recent memories for an owner, optionally filtered by `slot` (type).
  - Response is minimal per item: `{ id, type, subject, content }`.

- memory-forget
  - Delete a memory by `id`. Consider recalling/listing first if you need to verify the item.

- memory-export
  - Export all memories for an owner as a JSON array. Useful for backup/migration.
  - Response items are minimal: `{ id, type, subject, content }`.

- memory-import
  - Bulk import memories for an owner. Each item mirrors the memory schema (`type`, `subject`, `content`, metadata, optional `embedding`). Max 1000 items per call.

## Embeddings
## Embeddings
Embeddings are optional—without a key the server relies on text search and recency heuristics.

Set `MEMORY_EMBEDDING_KEY` (or pass `--embed-key=...` to the CLI) to automatically create embeddings when remembering/importing memories and to embed recall queries. The default model is `text-embedding-3-small`; override it with `MEMORY_EMBED_MODEL` or `--embed-model`. To disable the built-in generator when using the programmatic API, pass `embeddingProvider: null` to `createMemoryMcpServer`. To specify a key programmatically, pass `embeddingApiKey: "sk-..."`.

Limits and validation
- memory-remember: `subject` max 160 chars, `content` max 1000, `sensitivity` up to 32 tags.
- memory-recall: optional `query` max 1000 chars; if omitted, listing is capped internally.
- memory-import: up to 1000 items per call; each item has the same field limits as remember.
