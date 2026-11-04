import type { DeviceStartDto, MeDto, PublishResultDto } from "@extshare/core";
import { DeviceTokenSchema, RefreshSchema, sha256Hex, ZIP_LIMITS } from "@extshare/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type Actor, AppError, type Deps } from "../context";
import type { AuthService } from "../services/auth";
import { auditDto, projectDto, releaseDto } from "../services/dto";
import type { ReleaseService } from "../services/releases";
import { clientIp } from "./util";

type Env = { Variables: { actor: Actor } };

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be JSON");
  }
}

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new AppError(400, "invalid_request", "Malformed request body");
  return r.data as T;
}

export function apiRoutes(deps: Deps, auth: AuthService, releases: ReleaseService) {
  const api = new Hono<Env>();

  // ---- unauthenticated: device login and token refresh ----

  api.post("/device/start", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { clientName?: unknown };
    const name = typeof body.clientName === "string" ? body.clientName : "extshare CLI";
    const dto: DeviceStartDto = auth.startDevice(name, clientIp(c, deps));
    return c.json(dto);
  });

  api.post("/device/token", async (c) => {
    const ip = clientIp(c, deps);
    if (!deps.limiter.take(`device-poll:${ip}`, 60, 60_000))
      throw new AppError(429, "rate_limited", "Polling too fast");
    const { deviceCode } = parse(DeviceTokenSchema, await jsonBody(c));
    const r = auth.pollDevice(deviceCode);
    return "pending" in r ? c.json(r, 202) : c.json(r);
  });

  api.post("/token/refresh", async (c) => {
    const ip = clientIp(c, deps);
    if (!deps.limiter.take(`refresh:${ip}`, 30, 60_000))
      throw new AppError(429, "rate_limited", "Too many refreshes");
    const { refreshToken } = parse(RefreshSchema, await jsonBody(c));
    return c.json(auth.refresh(refreshToken, ip));
  });

  // ---- bearer-authenticated: everything except the three public routes above ----

  const PUBLIC = new Set(["/device/start", "/device/token", "/token/refresh"]);
  const authed = api;
  api.use("*", async (c, next) => {
    if (PUBLIC.has(c.req.path.replace(/^\/api/, ""))) return next();
    const h = c.req.header("authorization");
    const token = h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
    c.set("actor", auth.authenticateBearer(token, clientIp(c, deps)));
    await next();
  });

  authed.post("/logout", (c) => {
    auth.revokeFamilyOf(c.req.header("authorization")!.slice(7).trim());
    return c.json({ ok: true });
  });

  authed.get("/me", (c) => {
    const a = c.get("actor");
    const user = deps.store.getUser(a.userId)!;
    const ws = deps.store.getWorkspace(a.workspaceId)!;
    const dto: MeDto = {
      email: user.email,
      name: user.name,
      workspace: { id: ws.id, name: ws.name, role: a.role },
    };
    return c.json(dto);
  });

  authed.get("/projects", (c) => c.json(deps.store.listProjects(c.get("actor").workspaceId).map(projectDto)));

  authed.post("/projects", async (c) =>
    c.json(projectDto(releases.createProject(c.get("actor"), await jsonBody(c))), 201),
  );

  authed.get("/projects/:id", (c) =>
    c.json(projectDto(releases.getProject(c.get("actor"), c.req.param("id")))),
  );

  authed.get("/projects/:id/releases", (c) => {
    const p = releases.getProject(c.get("actor"), c.req.param("id"));
    return c.json(deps.store.listReleases(p.id).map((r) => releaseDto(r, deps.store)));
  });

  authed.post(
    "/projects/:id/releases",
    bodyLimit({
      maxSize: ZIP_LIMITS.maxPackageBytes + 256 * 1024,
      onError: () => {
        throw new AppError(413, "too_large", `Package exceeds ${ZIP_LIMITS.maxPackageBytes} bytes`);
      },
    }),
    async (c) => {
      const actor = c.get("actor");
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        throw new AppError(
          400,
          "invalid_request",
          "Expected multipart/form-data with 'meta' and 'package' fields",
        );
      }
      const pkg = form.get("package");
      const metaRaw = form.get("meta");
      if (!(pkg instanceof File) || typeof metaRaw !== "string") {
        throw new AppError(
          400,
          "invalid_request",
          "Expected 'package' (file) and 'meta' (JSON string) fields",
        );
      }
      let meta: unknown;
      try {
        meta = JSON.parse(metaRaw);
      } catch {
        throw new AppError(400, "invalid_request", "'meta' is not valid JSON");
      }
      const bytes = new Uint8Array(await pkg.arrayBuffer());
      // The CLI sends its own hash; a mismatch means the upload was altered or truncated in transit.
      const claimed = c.req.header("x-content-sha256");
      if (claimed && claimed !== sha256Hex(bytes)) {
        throw new AppError(
          400,
          "hash_mismatch",
          "Received package does not match the hash the CLI computed; retry the upload",
        );
      }
      const result = await releases.publish(actor, c.req.param("id"), bytes, meta);
      const dto: PublishResultDto = {
        release: releaseDto(result.release, deps.store),
        invite: result.invite,
      };
      return c.json(dto, 201);
    },
  );

  authed.get("/releases/:id", (c) => {
    const { release } = releases.getRelease(c.get("actor"), c.req.param("id"));
    return c.json(releaseDto(release, deps.store));
  });

  authed.post("/releases/:id/sync", async (c) => {
    const r = await releases.sync(c.get("actor"), c.req.param("id"));
    return c.json(releaseDto(r, deps.store));
  });

  authed.post("/releases/:id/revoke", async (c) => {
    const r = await releases.revoke(c.get("actor"), c.req.param("id"), await jsonBody(c));
    return c.json({
      release: releaseDto(r.release, deps.store),
      withdrawal: r.withdrawal ? releaseDto(r.withdrawal, deps.store) : null,
    });
  });

  authed.post("/releases/:id/extend", async (c) => {
    const r = releases.extend(c.get("actor"), c.req.param("id"), await jsonBody(c));
    return c.json(releaseDto(r, deps.store));
  });

  authed.get("/releases/:id/testers", (c) => {
    const { release } = releases.getRelease(c.get("actor"), c.req.param("id"));
    return c.json(deps.store.listTesters(release.id).map((t) => t.email));
  });

  authed.post("/releases/:id/testers", async (c) =>
    c.json(releases.changeTesters(c.get("actor"), c.req.param("id"), await jsonBody(c))),
  );

  authed.post("/releases/:id/invites", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(releases.rotateInvite(c.get("actor"), c.req.param("id"), body), 201);
  });

  authed.get("/releases/:id/audit", (c) => {
    const actor = c.get("actor");
    const { release } = releases.getRelease(actor, c.req.param("id"));
    return c.json(
      deps.store.listAudit({ workspaceId: actor.workspaceId, target: release.id, limit: 200 }).map(auditDto),
    );
  });

  authed.get("/releases/:id/artifact", async (c) => {
    const actor = c.get("actor");
    const { release } = releases.getRelease(actor, c.req.param("id"));
    const bytes = await deps.artifacts.get(release.sha256);
    if (!bytes) throw new AppError(404, "not_found", "Artifact not found");
    return new Response(bytes, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${release.id}-${release.version}.zip"`,
        "x-content-sha256": release.sha256,
      },
    });
  });

  return api;
}
