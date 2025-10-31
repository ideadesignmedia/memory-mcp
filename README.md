# @ideadesignmedia/memory-mcp

SQLite-backed memory for MCP agents. Ships a CLI and programmatic API.

Highlights
- Uses `sqlite3` (async) for broad prebuilt support; no brittle native build steps.
- Optional FTS5 indexing for better search; falls back to `LIKE` when unavailable.
- Input validation and sane limits to guard against oversized payloads.

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
await runStdioServer({ dbPath: "./memory.db", defaultTopK: 6 });
```

## Tools
- memory.remember
- memory.recall
- memory.list
- memory.forget
- memory.export
- memory.import

All tools are safe for STDIO. The server writes logs to stderr only.

Limits and validation
- memory.remember: `subject` max 160 chars, `content` max 1000, `sensitivity` up to 32 tags.
- memory.recall: optional `query` max 1000 chars; if omitted, listing is capped internally.
- memory.import: up to 1000 items per call; each item has the same field limits as remember.
