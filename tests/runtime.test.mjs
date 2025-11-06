import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import * as memoryMcp from "../dist/index.js";

const { MemoryStore, createMemoryMcpServer } = memoryMcp;

const createTempDbPath = async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-mcp-"));
  return { dbPath: join(dir, `memory-${randomUUID()}.sqlite`), dir };
};

test("MemoryStore v2 can insert and list records", async (t) => {
  const { dbPath, dir } = await createTempDbPath();

  const store = new MemoryStore(dbPath);
  const id = await store.insert({ subject: "test subject", content: "test content" });

  const items = await store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, id);
  assert.equal(items[0]?.subject, "test subject");

  await rm(dir, { recursive: true, force: true });
});

test("Server v2 factory builds without embedding provider", async () => {
  const server = createMemoryMcpServer({
    dbPath: ":memory:",
    embeddingProvider: null,
  });
  assert.ok(server);
  assert.equal(typeof server.start, "function");
});
