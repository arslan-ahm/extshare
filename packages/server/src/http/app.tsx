import type { ApiErrorBody } from "@extshare/core";
import { Hono } from "hono";
import { AppError, type Deps } from "../context";
import { AuthService } from "../services/auth";
import { ReleaseService } from "../services/releases";
import { apiRoutes } from "./api";
// Inlined at build time so the bundled server ships as a single file.
import CSS from "./assets/app.css" with { type: "text" };
import { dashboardRoutes } from "./dashboard";
import { gatewayRoutes } from "./gateway";
import { Layout } from "./views";

export function createApp(deps: Deps) {
  const auth = new AuthService(deps);
  const releases = new ReleaseService(deps);
  const app = new Hono();
  const https = deps.config.publicUrl.startsWith("https://");

  app.use("*", async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set(
      "content-security-policy",
      "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
    );
    // Invite tokens live in the URL; never leak them to the Web Store or anywhere else via Referer.
    h.set("referrer-policy", "no-referrer");
    h.set("x-content-type-options", "nosniff");
    h.set("x-frame-options", "DENY");
    h.set("cross-origin-opener-policy", "same-origin");
    h.set("permissions-policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
    if (https) h.set("strict-transport-security", "max-age=63072000; includeSubDomains");
    if (!h.has("cache-control")) h.set("cache-control", "no-store");
  });

  app.onError((err, c) => {
    const isApi = c.req.path.startsWith("/api/");
    if (err instanceof AppError) {
      if (isApi) {
        const body: ApiErrorBody = {
          error: {
            code: err.code,
            message: err.message,
            ...(err.findings ? { findings: err.findings } : {}),
          },
        };
        return c.json(body, err.status);
      }
      return c.html(
        <Layout title="Error" narrow>
          <h1>{err.status === 404 ? "Not found" : "Something went wrong"}</h1>
          <p class="lede">{err.message}</p>
          <a class="btn" href="/">
            Back to projects
          </a>
        </Layout>,
        err.status,
      );
    }
    deps.log("error", "unhandled error", {
      path: c.req.path,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    if (isApi)
      return c.json(
        { error: { code: "internal", message: "Internal server error" } } satisfies ApiErrorBody,
        500,
      );
    return c.html(
      <Layout title="Error" narrow>
        <h1>Something went wrong</h1>
        <p class="lede">The error was logged. Try again in a moment.</p>
      </Layout>,
      500,
    );
  });

  app.notFound((c) =>
    c.req.path.startsWith("/api/")
      ? c.json({ error: { code: "not_found", message: "No such endpoint" } } satisfies ApiErrorBody, 404)
      : c.html(
          <Layout title="Not found" narrow>
            <h1>Not found</h1>
            <p class="lede">There is nothing at this address.</p>
          </Layout>,
          404,
        ),
  );

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/assets/app.css", (c) => {
    c.header("cache-control", "public, max-age=3600");
    return c.body(CSS, 200, { "content-type": "text/css; charset=utf-8" });
  });

  app.route("/api", apiRoutes(deps, auth, releases));
  app.route("/", gatewayRoutes(deps, releases));
  app.route("/", dashboardRoutes(deps, auth, releases));

  return { app, auth, releases };
}
