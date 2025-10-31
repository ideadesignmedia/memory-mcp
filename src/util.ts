export const nowIso = () => new Date().toISOString();

export function recencyDecay(d?: string, halfLifeDays = 30): number {
  if (!d) return 0.6;
  const days = (Date.now() - new Date(d).getTime()) / 864e5;
  return 1 / (1 + Math.max(days, 0) / halfLifeDays);
}

export function logErr(...args: unknown[]) {
  try { process.stderr.write(args.map(String).join(" ") + "\n"); } catch {}
}
