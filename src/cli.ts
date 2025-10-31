#!/usr/bin/env node
import "dotenv/config";
import { runStdioServer } from "./server.js";
import { logErr } from "./util.js";

const args = new Map<string, string | boolean>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.split("=");
    args.set(k.replace(/^--/, ""), v ?? true);
  }
}

const dbPath = (args.get("db") as string) || process.env.MEMORY_DB || "./memory.db";
const topk = parseInt((args.get("topk") as string) || process.env.MEMORY_TOPK || "6");

runStdioServer({ dbPath, defaultTopK: Number.isFinite(topk) ? topk : 6 }).catch(err => {
  logErr("fatal:", err?.stack || String(err));
  process.exit(1);
});
