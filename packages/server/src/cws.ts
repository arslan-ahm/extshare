import { createSign } from "node:crypto";
import type { CwsItemState, CwsItemStatus, CwsUploadState } from "@extshare/core";

/**
 * Chrome Web Store API v2 client. Endpoints and shapes follow
 * https://developer.chrome.com/docs/webstore/api/reference/rest (publishers.items, media.upload).
 */

export const CWS_BASE = "https://chromewebstore.googleapis.com";
export const CWS_SCOPE = "https://www.googleapis.com/auth/chromewebstore";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CwsUploadResult {
  itemId?: string;
  crxVersion?: string;
  uploadState: CwsUploadState;
}

export interface CwsPublishResult {
  state: CwsItemState;
  warnings: { reason: string; description: string }[];
}

export interface CwsClient {
  upload(itemId: string, zip: Uint8Array): Promise<CwsUploadResult>;
  publish(
    itemId: string,
    opts: { publishType: "DEFAULT_PUBLISH" | "STAGED_PUBLISH" },
  ): Promise<CwsPublishResult>;
  fetchStatus(itemId: string): Promise<CwsItemStatus>;
  cancelSubmission(itemId: string): Promise<void>;
}

export class CwsApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    message: string,
  ) {
    super(`Chrome Web Store ${operation} failed (HTTP ${status}): ${message}`);
    this.name = "CwsApiError";
  }
}

export interface AccessTokenProvider {
  getToken(): Promise<string>;
}

async function readGoogleError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string };
    if (typeof j.error === "object" && j.error?.message) return j.error.message;
    if (j.error_description) return j.error_description;
    if (typeof j.error === "string") return j.error;
  } catch {}
  return text.slice(0, 500) || res.statusText;
}

abstract class CachingTokenProvider implements AccessTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    protected readonly fetchFn: FetchFn,
    protected readonly now: () => number,
  ) {}

  protected abstract tokenRequestBody(): URLSearchParams;
  protected tokenUrl(): string {
    return GOOGLE_TOKEN_URL;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    // Concurrent callers share one refresh instead of each hitting the token endpoint.
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const res = await this.fetchFn(this.tokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: this.tokenRequestBody(),
    });
    if (!res.ok) throw new CwsApiError("token", res.status, await readGoogleError(res));
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new CwsApiError("token", res.status, "response had no access_token");
    this.cached = { token: j.access_token, expiresAt: this.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }
}

/** OAuth client + refresh token, as described in the "Using the Chrome Web Store API" guide. */
export class RefreshTokenProvider extends CachingTokenProvider {
  constructor(
    private readonly creds: { clientId: string; clientSecret: string; refreshToken: string },
    fetchFn: FetchFn,
    now: () => number,
  ) {
    super(fetchFn, now);
  }
  protected tokenRequestBody() {
    return new URLSearchParams({
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      refresh_token: this.creds.refreshToken,
      grant_type: "refresh_token",
    });
  }
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Service account linked to the publisher in the Developer Dashboard (supported by API v2). */
export class ServiceAccountProvider extends CachingTokenProvider {
  constructor(
    private readonly key: ServiceAccountKey,
    fetchFn: FetchFn,
    now: () => number,
  ) {
    super(fetchFn, now);
    if (!key.client_email || !key.private_key)
      throw new Error("Service account key needs client_email and private_key");
  }
  protected override tokenUrl() {
    return this.key.token_uri ?? GOOGLE_TOKEN_URL;
  }
  protected tokenRequestBody() {
    const iat = Math.floor(this.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
      iss: this.key.client_email,
      scope: CWS_SCOPE,
      aud: this.tokenUrl(),
      iat,
      exp: iat + 3600,
    })}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(this.key.private_key).toString("base64url");
    return new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${sig}`,
    });
  }
}

export class HttpCwsClient implements CwsClient {
  constructor(
    private readonly publisherId: string,
    private readonly tokens: AccessTokenProvider,
    private readonly fetchFn: FetchFn,
  ) {
    if (!/^[\w.-]+$/.test(publisherId)) throw new Error("Invalid CWS publisher ID");
  }

  private name(itemId: string) {
    if (!/^[a-p]{32}$/.test(itemId)) throw new Error(`Invalid item ID: ${itemId}`);
    return `publishers/${this.publisherId}/items/${itemId}`;
  }

  private async call<T>(operation: string, url: string, init: RequestInit): Promise<T> {
    const token = await this.tokens.getToken();
    const res = await this.fetchFn(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new CwsApiError(operation, res.status, await readGoogleError(res));
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async upload(itemId: string, zip: Uint8Array) {
    return this.call<CwsUploadResult>("upload", `${CWS_BASE}/upload/v2/${this.name(itemId)}:upload`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: new Uint8Array(zip),
    });
  }

  async publish(itemId: string, opts: { publishType: "DEFAULT_PUBLISH" | "STAGED_PUBLISH" }) {
    const r = await this.call<{
      state: CwsItemState;
      warningInfo?: { warnings?: { reason: string; description: string }[] };
    }>("publish", `${CWS_BASE}/v2/${this.name(itemId)}:publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publishType: opts.publishType }),
    });
    return { state: r.state, warnings: r.warningInfo?.warnings ?? [] };
  }

  async fetchStatus(itemId: string) {
    return this.call<CwsItemStatus>("fetchStatus", `${CWS_BASE}/v2/${this.name(itemId)}:fetchStatus`, {
      method: "GET",
    });
  }

  async cancelSubmission(itemId: string) {
    await this.call<unknown>("cancelSubmission", `${CWS_BASE}/v2/${this.name(itemId)}:cancelSubmission`, {
      method: "POST",
    });
  }
}
