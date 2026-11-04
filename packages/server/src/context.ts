import type { Finding } from "@extshare/core";
import type { ArtifactStore } from "./artifacts";
import type { CwsClient } from "./cws";
import type { IdentityProvider } from "./oidc";
import type { RateLimiter, Signer } from "./security";
import type { Role, Store } from "./store/types";

export interface AppConfig {
  /** Origin the server is reached at, e.g. https://extshare.example.com (no trailing slash). */
  publicUrl: string;
  /** Polls of fetchStatus while the Web Store finishes processing an upload, before handing off to the sync loop. */
  uploadPollAttempts: number;
  uploadPollIntervalMs: number;
  /** Trust X-Forwarded-For from the reverse proxy for client IPs. */
  trustProxy: boolean;
}

export interface Deps {
  store: Store;
  artifacts: ArtifactStore;
  cws: CwsClient;
  /** Null when tester sign-in is not configured; the gateway then refuses to authenticate anyone. */
  idp: IdentityProvider | null;
  signer: Signer;
  limiter: RateLimiter;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  config: AppConfig;
  log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
}

export interface Actor {
  userId: string;
  email: string;
  workspaceId: string;
  role: Role;
  ip: string | null;
}

export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 502 | 503,
    readonly code: string,
    message: string,
    readonly findings?: Finding[],
  ) {
    super(message);
    this.name = "AppError";
  }
}

const RANK: Record<Role, number> = { viewer: 0, publisher: 1, owner: 2 };

export function requireRole(actor: Actor, min: Role) {
  if (RANK[actor.role] < RANK[min])
    throw new AppError(403, "forbidden", `This action needs the ${min} role; you are ${actor.role}`);
}
