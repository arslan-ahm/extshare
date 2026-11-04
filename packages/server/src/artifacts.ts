import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@extshare/core";
import { randomToken } from "./security";

/** Content-addressed package storage. Keys are SHA-256 hex digests of the ZIP bytes. */
export interface ArtifactStore {
  put(sha256: string, bytes: Uint8Array): Promise<void>;
  get(sha256: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

function assertSha(sha256: string) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid artifact key");
}

export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly dir: string) {}

  private path(sha256: string) {
    assertSha(sha256);
    return join(this.dir, sha256.slice(0, 2), `${sha256}.zip`);
  }

  async put(sha256: string, bytes: Uint8Array) {
    if (sha256Hex(bytes) !== sha256) throw new Error("Artifact bytes do not match their hash");
    const dest = this.path(sha256);
    if (existsSync(dest)) return;
    await mkdir(join(this.dir, sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash never leaves a truncated artifact under its final name.
    const tmp = `${dest}.${randomToken(6)}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, dest);
  }

  async get(sha256: string) {
    try {
      const bytes = new Uint8Array(await readFile(this.path(sha256)));
      if (sha256Hex(bytes) !== sha256) throw new Error(`Stored artifact ${sha256} is corrupt`);
      return bytes;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(sha256: string, bytes: Uint8Array) {
    assertSha(sha256);
    if (sha256Hex(bytes) !== sha256) throw new Error("Artifact bytes do not match their hash");
    this.blobs.set(sha256, new Uint8Array(bytes));
  }
  async get(sha256: string) {
    assertSha(sha256);
    const b = this.blobs.get(sha256);
    return b ? new Uint8Array(b) : null;
  }
}
