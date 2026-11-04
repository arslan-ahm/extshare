import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ZIP_LIMITS } from "@extshare/core";
import { FsArtifactStore } from "./artifacts";
import { cwsCredentials, loadEnv } from "./config";
import type { Deps } from "./context";
import { HttpCwsClient, RefreshTokenProvider, ServiceAccountProvider } from "./cws";
import { createApp } from "./http/app";
import { GoogleIdentityProvider } from "./oidc";
import { startScheduler } from "./scheduler";
import { RateLimiter, Signer } from "./security";
import { SqliteStore } from "./store/sqlite";

const env = loadEnv(process.env);
mkdirSync(env.DATA_DIR, { recursive: true, mode: 0o700 });

const now = () => Date.now();
const log: Deps["log"] = (level, msg, extra) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === "error" ? console.error : console.log)(line);
};

const creds = cwsCredentials(env);
const tokens =
  creds.kind === "service_account"
    ? new ServiceAccountProvider(creds.key, fetch, now)
    : new RefreshTokenProvider(creds, fetch, now);

const deps: Deps = {
  store: SqliteStore.open(join(env.DATA_DIR, "extshare.db")),
  artifacts: new FsArtifactStore(join(env.DATA_DIR, "artifacts")),
  cws: new HttpCwsClient(env.CWS_PUBLISHER_ID, tokens, fetch),
  idp: env.GOOGLE_CLIENT_ID
    ? new GoogleIdentityProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET!, fetch, now)
    : null,
  signer: new Signer(env.SECRET),
  limiter: new RateLimiter(now),
  now,
  sleep: (ms) => Bun.sleep(ms),
  config: {
    publicUrl: env.PUBLIC_URL,
    uploadPollAttempts: 10,
    uploadPollIntervalMs: 3000,
    trustProxy: env.TRUST_PROXY === "true",
  },
  log,
};

const { app, releases } = createApp(deps);
const stop = startScheduler(deps, releases, env.SYNC_INTERVAL_SEC * 1000);

const server = Bun.serve({
  hostname: env.HOST,
  port: env.PORT,
  maxRequestBodySize: ZIP_LIMITS.maxPackageBytes + 1024 * 1024,
  fetch: (req, srv) => app.fetch(req, { server: srv }),
});

log("info", "extshare server listening", {
  url: `http://${server.hostname}:${server.port}`,
  publicUrl: env.PUBLIC_URL,
  cwsAuth: creds.kind,
  testerSignIn: deps.idp ? "google" : "disabled",
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stop();
    server.stop();
    process.exit(0);
  });
}
