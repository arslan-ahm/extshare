import { createHash } from "node:crypto";
import { type Finding, type ManifestSummary, validateManifest } from "./manifest";
import { type ScanOptions, scanFiles } from "./scan";
import { extractZip, ZipError } from "./zip";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface PackageReport {
  ok: boolean;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  uncompressedBytes: number;
  manifest: ManifestSummary | null;
  findings: Finding[];
}

/**
 * The single authority on whether a ZIP may be published. The CLI runs it before
 * uploading for fast feedback; the server runs it again and only trusts its own result.
 */
export function inspectPackage(bytes: Uint8Array, opts: ScanOptions = {}): PackageReport {
  const base = { sha256: sha256Hex(bytes), sizeBytes: bytes.length };
  let extracted: ReturnType<typeof extractZip>;
  try {
    extracted = extractZip(bytes);
  } catch (e) {
    const code = e instanceof ZipError ? e.code : "zip_error";
    return {
      ...base,
      ok: false,
      fileCount: 0,
      uncompressedBytes: 0,
      manifest: null,
      findings: [{ severity: "error", code: `zip_${code}`, message: (e as Error).message }],
    };
  }
  const { files } = extracted;
  const findings: Finding[] = [];
  let manifest: ManifestSummary | null = null;

  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) {
    const nested = [...files.keys()].find((f) => f.endsWith("/manifest.json"));
    findings.push({
      severity: "error",
      code: "manifest_missing",
      message: nested
        ? `manifest.json must be at the ZIP root, found it at "${nested}"; zip the build directory's contents, not the directory`
        : "manifest.json is missing from the package root",
    });
  } else {
    let parsed: unknown;
    try {
      // TextDecoder drops a leading UTF-8 BOM, which Chrome also tolerates in manifest.json.
      parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch (e) {
      findings.push({
        severity: "error",
        code: "manifest_json",
        message: `manifest.json is not valid JSON: ${(e as Error).message}`,
        file: "manifest.json",
      });
    }
    if (parsed !== undefined) {
      const r = validateManifest(parsed, new Set(files.keys()));
      findings.push(...r.findings);
      manifest = r.summary;
    }
  }
  findings.push(...scanFiles(files, opts));

  return {
    ...base,
    ok: !findings.some((f) => f.severity === "error"),
    fileCount: files.size,
    uncompressedBytes: extracted.totalUncompressed,
    manifest,
    findings,
  };
}
