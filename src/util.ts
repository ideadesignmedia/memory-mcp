export const nowIso = () => new Date().toISOString();

export function recencyDecay(d?: string, halfLifeDays = 30): number {
  if (!d) return 0.6;
  const days = (Date.now() - new Date(d).getTime()) / 864e5;
  return 1 / (1 + Math.max(days, 0) / halfLifeDays);
}

export function logErr(...args: unknown[]) {
  try { process.stderr.write(args.map(String).join(" ") + "\n"); } catch {}
}

export function cosineSimilarity(a?: number[], b?: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (!Number.isFinite(ai) || !Number.isFinite(bi)) continue;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}
