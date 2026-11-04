import { unzipSync, zipSync } from "fflate";

/** Hard limits applied to every uploaded package, on the CLI and again on the server. */
export const ZIP_LIMITS = {
  maxPackageBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxEntries: 5000,
  maxCompressionRatio: 200,
} as const;

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  isDirectory: boolean;
  isSymlink: boolean;
}

export class ZipError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Reads the central directory without decompressing anything, so size, count and
 * path checks run before any inflate work is done.
 */
export function listZipEntries(bytes: Uint8Array): ZipEntryInfo[] {
  if (bytes.length > ZIP_LIMITS.maxPackageBytes) {
    throw new ZipError(
      `Package is ${bytes.length} bytes; limit is ${ZIP_LIMITS.maxPackageBytes}`,
      "too_large",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  // EOCD is 22 bytes plus an optional comment of up to 65535 bytes.
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("Not a ZIP archive (no end-of-central-directory record)", "not_zip");

  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total === 0xffff || cdOffset === 0xffffffff)
    throw new ZipError("ZIP64 archives are not supported", "zip64");
  if (total > ZIP_LIMITS.maxEntries)
    throw new ZipError(`Package has ${total} entries; limit is ${ZIP_LIMITS.maxEntries}`, "too_many_entries");
  if (cdOffset + cdSize > eocd) throw new ZipError("Corrupt central directory", "corrupt");

  const entries: ZipEntryInfo[] = [];
  let p = cdOffset;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let n = 0; n < total; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CDH_SIG)
      throw new ZipError("Corrupt central directory entry", "corrupt");
    const madeBy = view.getUint16(p + 4, true) >> 8;
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const externalAttrs = view.getUint32(p + 38, true);
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    } catch {
      throw new ZipError("Entry name is not valid UTF-8", "bad_name");
    }
    const unixMode = madeBy === 3 ? externalAttrs >>> 16 : 0;
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      isDirectory: name.endsWith("/"),
      isSymlink: (unixMode & S_IFMT) === S_IFLNK,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Returns a reason string when the entry path is unsafe to extract, otherwise null. */
export function unsafePathReason(name: string): string | null {
  if (name.length === 0) return "empty path";
  if (name.includes("\0")) return "NUL byte in path";
  if (name.includes("\\")) return "backslash in path";
  if (name.startsWith("/")) return "absolute path";
  if (/^[a-zA-Z]:/.test(name)) return "drive-letter path";
  const segments = name.split("/");
  if (segments.some((s) => s === "..")) return "parent-directory traversal";
  if (segments.slice(0, -1).some((s) => s === "" || s === ".")) return "empty or '.' path segment";
  return null;
}

export interface ExtractedPackage {
  files: Map<string, Uint8Array>;
  entries: ZipEntryInfo[];
  totalUncompressed: number;
}

/** Validates structure, then decompresses. Throws ZipError on anything unsafe. */
export function extractZip(bytes: Uint8Array): ExtractedPackage {
  const entries = listZipEntries(bytes);
  const seen = new Set<string>();
  let total = 0;
  for (const e of entries) {
    const reason = unsafePathReason(e.name);
    if (reason) throw new ZipError(`Unsafe entry "${e.name}": ${reason}`, "unsafe_path");
    if (e.isSymlink) throw new ZipError(`Entry "${e.name}" is a symlink`, "symlink");
    const key = e.name.toLowerCase();
    if (seen.has(key))
      throw new ZipError(`Duplicate entry "${e.name}" (paths are compared case-insensitively)`, "duplicate");
    seen.add(key);
    total += e.uncompressedSize;
    if (
      e.compressedSize > 0 &&
      e.uncompressedSize / e.compressedSize > ZIP_LIMITS.maxCompressionRatio &&
      e.uncompressedSize > 1024 * 1024
    ) {
      throw new ZipError(`Entry "${e.name}" has a suspicious compression ratio`, "zip_bomb");
    }
  }
  if (total > ZIP_LIMITS.maxUncompressedBytes) {
    throw new ZipError(
      `Package expands to ${total} bytes; limit is ${ZIP_LIMITS.maxUncompressedBytes}`,
      "too_large",
    );
  }

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes);
  } catch (err) {
    throw new ZipError(`ZIP could not be decompressed: ${(err as Error).message}`, "corrupt");
  }
  const files = new Map<string, Uint8Array>();
  let actual = 0;
  for (const [name, data] of Object.entries(raw)) {
    if (name.endsWith("/")) continue;
    if (!seen.has(name.toLowerCase()))
      throw new ZipError(`Entry "${name}" is not in the central directory`, "corrupt");
    actual += data.length;
    if (actual > ZIP_LIMITS.maxUncompressedBytes)
      throw new ZipError("Package expands beyond the size limit", "too_large");
    files.set(name, data);
  }
  return { files, entries, totalUncompressed: actual };
}

/** Deterministic ZIP builder (sorted entries, fixed mtime) so identical input gives an identical hash. */
export function buildZip(files: Map<string, Uint8Array>): Uint8Array {
  const sorted: Record<string, [Uint8Array, { mtime: Date }]> = {};
  const mtime = new Date("2000-01-01T00:00:00Z");
  for (const name of [...files.keys()].sort()) {
    sorted[name] = [files.get(name)!, { mtime }];
  }
  return zipSync(sorted, { level: 9 });
}
