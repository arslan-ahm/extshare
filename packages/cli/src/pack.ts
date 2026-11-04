import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildZip, ZIP_LIMITS } from "@extshare/core";
import { CliError, PROJECT_FILE } from "./context";

/** Never packaged: VCS metadata, dependencies, OS litter and the CLI's own project file. */
const ALWAYS_SKIP = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db", "desktop.ini", PROJECT_FILE]);

export interface PackResult {
  zip: Uint8Array;
  files: string[];
  skipped: string[];
}

/**
 * Builds the upload ZIP from a build directory (its contents become the ZIP root) or reads an
 * existing .zip as-is. Symlinks are refused rather than followed.
 */
export function packPath(path: string): PackResult {
  if (!existsSync(path)) throw new CliError(`No such file or directory: ${path}`);
  const st = statSync(path);
  if (st.isFile()) {
    if (!path.toLowerCase().endsWith(".zip")) throw new CliError("Pass a build directory or a .zip file");
    if (st.size > ZIP_LIMITS.maxPackageBytes)
      throw new CliError(`ZIP is larger than ${ZIP_LIMITS.maxPackageBytes} bytes`);
    return { zip: new Uint8Array(readFileSync(path)), files: [], skipped: [] };
  }
  const files = new Map<string, Uint8Array>();
  const skipped: string[] = [];
  let total = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(path, full).split(sep).join("/");
      if (ALWAYS_SKIP.has(name)) {
        skipped.push(rel);
        continue;
      }
      const ls = lstatSync(full);
      if (ls.isSymbolicLink()) throw new CliError(`Refusing to package symlink: ${rel}`);
      if (ls.isDirectory()) walk(full);
      else if (ls.isFile()) {
        total += ls.size;
        if (total > ZIP_LIMITS.maxUncompressedBytes)
          throw new CliError("Build directory exceeds the package size limit");
        files.set(rel, new Uint8Array(readFileSync(full)));
      }
    }
  };
  walk(path);
  if (files.size === 0) throw new CliError(`${path} is empty`);
  if (!files.has("manifest.json")) {
    throw new CliError(
      `No manifest.json at the root of ${path}. Pass your extension's build output directory (for example ./dist).`,
    );
  }
  return { zip: buildZip(files), files: [...files.keys()], skipped };
}
