import type { ApiErrorBody, Finding, TokenDto } from "@extshare/core";
import { type CliContext, CliError, type Credentials, readCredentials, writeCredentials } from "./context";

export class ApiError extends CliError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly findings: Finding[] = [],
  ) {
    super(message, status === 401 ? 3 : 1);
    this.name = "ApiError";
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {}
  return new ApiError(
    res.status,
    body.error?.code ?? "http_error",
    body.error?.message ?? `HTTP ${res.status}`,
    body.error?.findings ?? [],
  );
}

/** Authenticated API client that refreshes the access token transparently and persists the rotated pair. */
export class Api {
  private creds: Credentials;

  constructor(
    private readonly ctx: CliContext,
    creds?: Credentials,
  ) {
    const c = creds ?? readCredentials(ctx);
    if (!c?.accessToken)
      throw new CliError("Not logged in. Run: extshare login --server https://your-extshare-server", 3);
    this.creds = c;
  }

  get server() {
    return this.creds.server;
  }

  private async refresh() {
    const res = await this.ctx.fetch(`${this.creds.server}/api/token/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: this.creds.refreshToken }),
    });
    if (!res.ok) {
      writeCredentials(this.ctx, null);
      throw new CliError("Your session expired or was revoked. Run: extshare login", 3);
    }
    const t = (await res.json()) as TokenDto;
    this.creds = { ...this.creds, ...t };
    writeCredentials(this.ctx, this.creds);
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const res = await this.raw(method, path, body, extraHeaders);
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as T;
  }

  /** Sends a request, refreshing once on expiry. FormData bodies are rebuilt per attempt by the caller via a factory. */
  async raw(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    if (this.creds.expiresAt - 30_000 <= this.ctx.now()) await this.refresh();
    const send = () => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.creds.accessToken}`,
        ...extraHeaders,
      };
      let payload: BodyInit | undefined;
      if (typeof body === "function") payload = (body as () => FormData)();
      else if (body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
      return this.ctx.fetch(`${this.creds.server}${path}`, { method, headers, body: payload });
    };
    let res = await send();
    if (res.status === 401) {
      await this.refresh();
      res = await send();
    }
    return res;
  }
}

/** Unauthenticated JSON call used by the login flow. */
export async function publicCall<T>(
  ctx: CliContext,
  server: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const res = await ctx.fetch(`${server}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status >= 400) throw await toApiError(res);
  return { status: res.status, body: (await res.json()) as T };
}
