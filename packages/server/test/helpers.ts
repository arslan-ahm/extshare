import { buildZip, type CwsItemState, type CwsItemStatus, type CwsUploadState } from "@extshare/core";
import { MemoryArtifactStore } from "../src/artifacts";
import type { Deps } from "../src/context";
import type { CwsClient, CwsPublishResult, CwsUploadResult } from "../src/cws";
import { createApp } from "../src/http/app";
import type { IdentityProvider, VerifiedIdentity } from "../src/oidc";
import { RateLimiter, Signer } from "../src/security";
import { MemoryStore } from "../src/store/memory";

export const ITEM_ID = "abcdefghijklmnopabcdefghijklmnop";
export const ITEM_ID_2 = "ponmlkjihgfedcbaponmlkjihgfedcba";
export const PUBLIC_URL = "https://extshare.test";
export const ORIGIN = { origin: PUBLIC_URL };

const enc = new TextEncoder();

/** Hand-built minimal MV3 package used as a test fixture (never persisted outside the in-memory store). */
export function fixturePackage(
  version: string,
  extra: Record<string, string> = {},
  manifestOverrides: Record<string, unknown> = {},
): Uint8Array {
  const manifest = {
    manifest_version: 3,
    name: "Fixture Ext",
    version,
    description: "fixture",
    icons: { "128": "icon.png" },
    background: { service_worker: "sw.js" },
    ...manifestOverrides,
  };
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["icon.png", new Uint8Array([137, 80, 78, 71])],
    ["sw.js", enc.encode("self.addEventListener('install', () => {});")],
  ]);
  for (const [k, v] of Object.entries(extra)) files.set(k, enc.encode(v));
  return buildZip(files);
}

export type CwsCall =
  | { op: "upload"; itemId: string; size: number }
  | { op: "publish"; itemId: string; publishType: string }
  | { op: "fetchStatus"; itemId: string }
  | { op: "cancelSubmission"; itemId: string };

/** Scriptable stand-in for the Chrome Web Store API; records every call. */
export class FakeCws implements CwsClient {
  calls: CwsCall[] = [];
  uploadState: CwsUploadState = "SUCCEEDED";
  uploadError: Error | null = null;
  publishState: CwsItemState = "PENDING_REVIEW";
  publishError: Error | null = null;
  publishWarnings: CwsPublishResult["warnings"] = [];
  status: CwsItemStatus = {};
  statusError: Error | null = null;
  /** Version reported for the most recent upload, read from the uploaded manifest. */
  lastUploadedVersion: string | null = null;

  async upload(itemId: string, zip: Uint8Array): Promise<CwsUploadResult> {
    this.calls.push({ op: "upload", itemId, size: zip.length });
    if (this.uploadError) throw this.uploadError;
    const { inspectPackage } = await import("@extshare/core");
    this.lastUploadedVersion = inspectPackage(zip).manifest?.version ?? null;
    return {
      itemId,
      uploadState: this.uploadState,
      crxVersion: this.uploadState === "SUCCEEDED" ? this.lastUploadedVersion! : undefined,
    };
  }
  async publish(itemId: string, opts: { publishType: string }): Promise<CwsPublishResult> {
    this.calls.push({ op: "publish", itemId, publishType: opts.publishType });
    if (this.publishError) throw this.publishError;
    return { state: this.publishState, warnings: this.publishWarnings };
  }
  async fetchStatus(itemId: string): Promise<CwsItemStatus> {
    this.calls.push({ op: "fetchStatus", itemId });
    if (this.statusError) throw this.statusError;
    return structuredClone(this.status);
  }
  async cancelSubmission(itemId: string) {
    this.calls.push({ op: "cancelSubmission", itemId });
  }
  ops() {
    return this.calls.map((c) => c.op);
  }
}

/** Identity provider stand-in: `code` values map to identities; anything else fails like a bad code would. */
export class FakeIdp implements IdentityProvider {
  identities = new Map<string, VerifiedIdentity>();
  lastExchange: { code: string; codeVerifier: string; redirectUri: string; nonce: string } | null = null;
  authorizationUrl(p: { state: string; nonce: string; codeVerifier: string; redirectUri: string }) {
    return `https://idp.test/auth?state=${encodeURIComponent(p.state)}&nonce=${encodeURIComponent(p.nonce)}&redirect_uri=${encodeURIComponent(p.redirectUri)}`;
  }
  async exchange(p: { code: string; codeVerifier: string; redirectUri: string; nonce: string }) {
    this.lastExchange = p;
    const id = this.identities.get(p.code);
    if (!id) {
      const { OidcError } = await import("../src/oidc");
      throw new OidcError("Google token exchange failed (HTTP 400)");
    }
    return id;
  }
}

export class Clock {
  constructor(public t = Date.UTC(2026, 10, 4, 12, 0, 0)) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export function makeDeps(overrides: Partial<Deps> = {}) {
  const clock = new Clock();
  const store = new MemoryStore();
  const artifacts = new MemoryArtifactStore();
  const cws = new FakeCws();
  const idp = new FakeIdp();
  const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
  const deps: Deps = {
    store,
    artifacts,
    cws,
    idp,
    signer: new Signer("test-secret-test-secret-test-secret-0123456789"),
    limiter: new RateLimiter(clock.now),
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    config: { publicUrl: PUBLIC_URL, uploadPollAttempts: 3, uploadPollIntervalMs: 1000, trustProxy: false },
    log: (level, msg, extra) => logs.push({ level, msg, extra }),
    ...overrides,
  };
  const { app, auth, releases } = createApp(deps);
  return { deps, app, auth, releases, clock, store, artifacts, cws, idp, logs };
}

/** Minimal cookie jar over Set-Cookie headers. */
export class Jar {
  cookies = new Map<string, string>();
  take(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(sc)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  header(): Record<string, string> {
    return this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {};
  }
}

export function csrfFrom(html: string): string {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  if (!m) throw new Error("No CSRF token in page");
  return m[1]!;
}

export function form(data: Record<string, string>): URLSearchParams {
  return new URLSearchParams(data);
}
