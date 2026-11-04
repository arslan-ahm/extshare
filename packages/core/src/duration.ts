const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export const MIN_TTL_MS = 15 * UNIT_MS.m;
export const MAX_TTL_MS = 90 * UNIT_MS.d;

/** Parses "30m", "12h", "7d" (or a combination such as "1d12h") into milliseconds within the allowed TTL range. */
export function parseTtl(input: string): number {
  const s = input.trim().toLowerCase();
  if (!/^(\d+[mhd])+$/.test(s)) throw new Error(`Invalid duration "${input}"; use forms like 30m, 12h, 7d`);
  let total = 0;
  for (const [, n, unit] of s.matchAll(/(\d+)([mhd])/g)) {
    total += Number(n) * UNIT_MS[unit as keyof typeof UNIT_MS];
  }
  if (total < MIN_TTL_MS) throw new Error(`Duration "${input}" is shorter than the 15m minimum`);
  if (total > MAX_TTL_MS) throw new Error(`Duration "${input}" exceeds the 90d maximum`);
  return total;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const d = Math.floor(ms / UNIT_MS.d);
  const h = Math.floor((ms % UNIT_MS.d) / UNIT_MS.h);
  const m = Math.floor((ms % UNIT_MS.h) / UNIT_MS.m);
  return [d && `${d}d`, h && `${h}h`, (m || (!d && !h)) && `${m}m`].filter(Boolean).join(" ");
}
