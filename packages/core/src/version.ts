/**
 * Chrome extension versions: one to four dot-separated integers, each 0..65535,
 * no leading zeros (https://developer.chrome.com/docs/extensions/reference/manifest/version).
 */
export function parseVersion(v: string): number[] | null {
  if (typeof v !== "string" || !/^\d+(\.\d+){0,3}$/.test(v)) return null;
  const parts = v.split(".").map((s) => {
    if (s.length > 1 && s.startsWith("0")) return Number.NaN;
    return Number(s);
  });
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 65535)) return null;
  if (parts.every((n) => n === 0)) return null;
  return parts;
}

/** Negative when a < b, zero when equal, positive when a > b. Missing components count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Invalid version: ${!pa ? a : b}`);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Smallest valid version strictly greater than `v`, used for withdrawal builds. */
export function nextVersion(v: string): string {
  const parts = parseVersion(v);
  if (!parts) throw new Error(`Invalid version: ${v}`);
  const padded = [...parts];
  while (padded.length < 4) padded.push(0);
  for (let i = padded.length - 1; i >= 0; i--) {
    if (padded[i]! < 65535) {
      padded[i]! += 1;
      for (let j = i + 1; j < padded.length; j++) padded[j] = 0;
      return padded.join(".");
    }
  }
  throw new Error(`No version exists above ${v}`);
}
