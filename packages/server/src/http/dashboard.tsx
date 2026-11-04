import { webStoreUrl } from "@extshare/core";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { raw } from "hono/html";
import QRCode from "qrcode";
import { AppError, type Deps } from "../context";
import { otpauthUri } from "../security";
import { type AuthService, actorFromSession, SESSION_TTL_MS, type SessionContext } from "../services/auth";
import type { ReleaseService } from "../services/releases";
import type { Project, Release } from "../store/types";
import { clientIp, cookieName, safeNext, sameOrigin, secureCookies } from "./util";
import { Alert, Csrf, Field, Findings, Layout, type NavUser, Remaining, StateBadge, Time } from "./views";

type Env = { Variables: { ctx: SessionContext } };

const SUCCESS: Record<string, string> = {
  project: "Project created.",
  testers: "Testers updated.",
  extended: "Test window extended.",
  revoked: "Release revoked. Its share links no longer work.",
  killswitch: "Release revoked and a withdrawal build was submitted to the Web Store.",
  synced: "Status refreshed from the Chrome Web Store.",
  device: "CLI approved. You can return to your terminal.",
  denied: "CLI login denied.",
};

export function dashboardRoutes(deps: Deps, auth: AuthService, releases: ReleaseService) {
  const app = new Hono<Env>();
  const SESSION = cookieName(deps, "xs_session");

  const setSession = (c: Context, id: string) =>
    setCookie(c, SESSION, id, {
      httpOnly: true,
      secure: secureCookies(deps),
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });

  const navUser = (ctx: SessionContext): NavUser => ({
    email: ctx.user.email,
    workspaceName: deps.store.getWorkspace(ctx.session.workspaceId)?.name ?? "",
    csrf: ctx.session.csrf,
  });

  /** Form posts must come from this origin and carry the session's CSRF token. */
  async function form(c: Context, ctx: SessionContext | null): Promise<Record<string, string>> {
    if (!sameOrigin(c, deps)) throw new AppError(403, "bad_origin", "Cross-site form submission refused");
    const body = await c.req.parseBody();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
    if (ctx && out._csrf !== ctx.session.csrf)
      throw new AppError(403, "bad_csrf", "Form expired; reload the page and try again");
    return out;
  }

  const notice = (c: Context) => SUCCESS[c.req.query("ok") ?? ""];

  // ---------- sign-in ----------

  const LoginPage = (p: { error?: string; next: string; email?: string }) => (
    <Layout title="Sign in" narrow>
      <h1>Sign in</h1>
      <p class="lede">Publisher accounts are created by an administrator with the admin CLI.</p>
      {p.error ? <Alert tone="error">{p.error}</Alert> : null}
      <form method="post" action={`/login?next=${encodeURIComponent(p.next)}`} class="stack">
        <Field label="Email" name="email" type="email" required autocomplete="username" value={p.email} />
        <Field label="Password" name="password" type="password" required autocomplete="current-password" />
        <button type="submit" class="btn btn-primary">
          Continue
        </button>
      </form>
    </Layout>
  );

  app.get("/login", (c) => {
    if (auth.resolveSession(getCookie(c, SESSION), true)) return c.redirect(safeNext(c.req.query("next")));
    return c.html(<LoginPage next={safeNext(c.req.query("next"))} />);
  });

  app.post("/login", async (c) => {
    const next = safeNext(c.req.query("next"));
    let f: Record<string, string> = {};
    try {
      f = await form(c, null);
      const { sessionId } = await auth.passwordLogin(f.email ?? "", f.password ?? "", clientIp(c, deps));
      setSession(c, sessionId);
      const ctx = auth.resolveSession(sessionId, false)!;
      return c.redirect(
        `${ctx.user.totpEnabled ? "/login/mfa" : "/mfa/setup"}?next=${encodeURIComponent(next)}`,
        303,
      );
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      return c.html(
        <LoginPage error={e.message} next={next} email={f.email} />,
        e.status === 429 ? 429 : 401,
      );
    }
  });

  const MfaPage = (p: {
    setup?: { secret: string; qr: string };
    error?: string;
    next: string;
    csrf: string;
  }) => (
    <Layout title="Two-factor authentication" narrow>
      <h1>{p.setup ? "Set up two-factor authentication" : "Enter your code"}</h1>
      {p.setup ? (
        <>
          <p class="lede">
            Every publisher account needs an authenticator app. Scan the code, then enter the 6-digit number
            it shows.
          </p>
          <div class="qr">{raw(p.setup.qr)}</div>
          <p class="hint">
            Can't scan? Enter this key manually: <code class="break">{p.setup.secret}</code>
          </p>
        </>
      ) : (
        <p class="lede">Open your authenticator app and enter the current 6-digit code.</p>
      )}
      {p.error ? <Alert tone="error">{p.error}</Alert> : null}
      <form
        method="post"
        action={`${p.setup ? "/mfa/setup" : "/login/mfa"}?next=${encodeURIComponent(p.next)}`}
        class="stack"
      >
        <Csrf token={p.csrf} />
        <Field label="6-digit code" name="code">
          <input
            id="f-code"
            name="code"
            inputmode="numeric"
            pattern="[0-9 ]{6,7}"
            autocomplete="one-time-code"
            required
          />
        </Field>
        <button type="submit" class="btn btn-primary">
          Verify
        </button>
      </form>
    </Layout>
  );

  const pendingCtx = (c: Context) => auth.resolveSession(getCookie(c, SESSION), false);

  async function renderMfa(c: Context, ctx: SessionContext, error?: string, status: 200 | 401 | 429 = 200) {
    const next = safeNext(c.req.query("next"));
    if (ctx.user.totpEnabled)
      return c.html(<MfaPage next={next} error={error} csrf={ctx.session.csrf} />, status);
    const secret = auth.beginTotpSetup(ctx);
    const qr = await QRCode.toString(otpauthUri(secret, ctx.user.email, "extshare"), {
      type: "svg",
      margin: 1,
      width: 200,
    });
    return c.html(
      <MfaPage setup={{ secret, qr }} next={next} error={error} csrf={ctx.session.csrf} />,
      status,
    );
  }

  for (const path of ["/login/mfa", "/mfa/setup"]) {
    app.get(path, async (c) => {
      const ctx = pendingCtx(c);
      if (!ctx) return c.redirect("/login");
      if (ctx.session.mfaPassed) return c.redirect(safeNext(c.req.query("next")));
      return renderMfa(c, ctx);
    });
    app.post(path, async (c) => {
      const ctx = pendingCtx(c);
      if (!ctx) return c.redirect("/login", 303);
      try {
        const f = await form(c, ctx);
        auth.verifyTotpForSession(ctx, f.code ?? "", clientIp(c, deps));
        return c.redirect(safeNext(c.req.query("next")), 303);
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        return renderMfa(
          c,
          auth.resolveSession(getCookie(c, SESSION), false) ?? ctx,
          e.message,
          e.status === 429 ? 429 : 401,
        );
      }
    });
  }

  app.post("/logout", async (c) => {
    const ctx = auth.resolveSession(getCookie(c, SESSION), false);
    if (ctx) await form(c, ctx);
    auth.logout(getCookie(c, SESSION));
    deleteCookie(c, SESSION, { path: "/", secure: secureCookies(deps) });
    return c.redirect("/login", 303);
  });

  // ---------- everything below needs a fully signed-in session ----------

  // The guard is bound to explicit paths so it can never swallow /r/*, /api/* or /assets/* mounted alongside.
  const guarded = new Hono<Env>();
  for (const path of ["/", "/projects", "/projects/*", "/releases/*", "/audit", "/device"]) {
    guarded.use(path, async (c, next) => {
      const ctx = auth.resolveSession(getCookie(c, SESSION), true);
      if (!ctx) {
        const pending = pendingCtx(c);
        const nextUrl = encodeURIComponent(c.req.path + (new URL(c.req.url).search || ""));
        return c.redirect(pending ? `/login/mfa?next=${nextUrl}` : `/login?next=${nextUrl}`, 303);
      }
      c.set("ctx", ctx);
      await next();
    });
  }

  /** Runs a form action; AppErrors re-render the page with the message instead of a bare error page. */
  async function action(
    c: Context<Env>,
    run: (f: Record<string, string>) => Promise<string> | string,
    onError: (msg: string) => Response | Promise<Response>,
  ) {
    const ctx = c.get("ctx");
    try {
      const f = await form(c, ctx);
      return c.redirect(await run(f), 303);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      c.status(e.status === 403 ? 403 : 400);
      return onError(
        e.findings?.length ? `${e.message}: ${e.findings.map((x) => x.message).join("; ")}` : e.message,
      );
    }
  }

  // ---------- projects ----------

  const ProjectsPage = (p: { ctx: SessionContext; error?: string; ok?: string }) => {
    const projects = deps.store.listProjects(p.ctx.session.workspaceId);
    const canEdit = p.ctx.membership.role !== "viewer";
    return (
      <Layout title="Projects" user={navUser(p.ctx)}>
        <h1>Projects</h1>
        {p.ok ? <Alert tone="ok">{p.ok}</Alert> : null}
        {p.error ? <Alert tone="error">{p.error}</Alert> : null}
        {projects.length === 0 ? (
          <div class="empty">
            <h2>No projects yet</h2>
            <p>
              A project links one Chrome Web Store item to this workspace. Create the item once in the
              Developer Dashboard, then link it here.
            </p>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Visibility</th>
                <th scope="col">Latest release</th>
                <th scope="col">Web Store item</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((pr) => {
                const latest = deps.store.listReleases(pr.id)[0];
                return (
                  <tr>
                    <td>
                      <a href={`/projects/${pr.id}`}>{pr.name}</a>
                    </td>
                    <td>{pr.visibility === "private" ? "Private" : "Unlisted"}</td>
                    <td>
                      {latest ? (
                        <>
                          <code>{latest.version}</code> <StateBadge state={latest.state} />
                        </>
                      ) : (
                        <span class="muted">none</span>
                      )}
                    </td>
                    <td>
                      <code class="mono-sm">{pr.itemId}</code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {canEdit ? (
          <section class="panel">
            <h2>Link a Web Store item</h2>
            <form method="post" action="/projects" class="grid-form">
              <Csrf token={p.ctx.session.csrf} />
              <Field label="Project name" name="name" required />
              <Field
                label="Extension item ID"
                name="itemId"
                required
                hint="32 letters (a-p) from the item's Developer Dashboard URL."
              />
              <Field
                label="Visibility on the Web Store"
                name="visibility"
                hint="Must match the item's setting in the Developer Dashboard."
              >
                <select id="f-visibility" name="visibility">
                  <option value="private">Private (trusted testers only)</option>
                  <option value="unlisted">Unlisted (anyone with the store link)</option>
                </select>
              </Field>
              <div class="form-actions">
                <button type="submit" class="btn btn-primary">
                  Create project
                </button>
              </div>
            </form>
          </section>
        ) : null}
      </Layout>
    );
  };

  guarded.get("/", (c) => c.html(<ProjectsPage ctx={c.get("ctx")} ok={notice(c)} />));

  guarded.post("/projects", (c) =>
    action(
      c,
      (f) => {
        const p = releases.createProject(actorFromSession(c.get("ctx"), clientIp(c, deps)), {
          name: f.name,
          itemId: (f.itemId ?? "").trim(),
          visibility: f.visibility,
        });
        return `/projects/${p.id}?ok=project`;
      },
      (msg) => c.html(<ProjectsPage ctx={c.get("ctx")} error={msg} />),
    ),
  );

  const ProjectPage = (p: { ctx: SessionContext; project: Project; ok?: string }) => {
    const list = deps.store.listReleases(p.project.id);
    const now = deps.now();
    return (
      <Layout title={p.project.name} user={navUser(p.ctx)}>
        <p class="crumbs">
          <a href="/">Projects</a>
        </p>
        <h1>{p.project.name}</h1>
        {p.ok ? <Alert tone="ok">{p.ok}</Alert> : null}
        <dl class="facts">
          <div>
            <dt>Web Store item</dt>
            <dd>
              <a href={webStoreUrl(p.project.itemId)} rel="noopener noreferrer" target="_blank">
                {p.project.itemId}
              </a>
            </dd>
          </div>
          <div>
            <dt>Visibility</dt>
            <dd>
              {p.project.visibility === "private"
                ? "Private: trusted testers only"
                : "Unlisted: anyone with the store link"}
            </dd>
          </div>
          <div>
            <dt>Project ID</dt>
            <dd>
              <code>{p.project.id}</code>
            </dd>
          </div>
        </dl>
        <h2>Releases</h2>
        {list.length === 0 ? (
          <div class="empty">
            <h3>No releases yet</h3>
            <p>Publish your build directory from the CLI:</p>
            <pre class="code">{`extshare init --project ${p.project.id}\nextshare publish ./dist --ttl 7d --testers you@example.com`}</pre>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Status</th>
                <th scope="col">Published</th>
                <th scope="col">Window</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr>
                  <td>
                    <a href={`/releases/${r.id}`}>
                      <code>{r.version}</code>
                    </a>
                    {r.kind === "withdrawal" ? <span class="tag">withdrawal</span> : null}
                  </td>
                  <td>
                    <StateBadge state={r.state} />
                  </td>
                  <td>
                    <Time ms={r.createdAt} />
                  </td>
                  <td>
                    {r.state === "revoked" || r.state === "expired" ? (
                      <span class="muted">closed</span>
                    ) : (
                      <Remaining until={r.expiresAt} now={now} />
                    )}
                  </td>
                  <td>{r.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Layout>
    );
  };

  guarded.get("/projects/:id", (c) => {
    const ctx = c.get("ctx");
    const project = releases.getProject(actorFromSession(ctx, null), c.req.param("id"));
    return c.html(<ProjectPage ctx={ctx} project={project} ok={notice(c)} />);
  });

  // ---------- release ----------

  const ReleasePage = (p: {
    ctx: SessionContext;
    release: Release;
    project: Project;
    error?: string;
    ok?: string;
    inviteUrl?: string;
  }) => {
    const { release: r, project, ctx } = p;
    const now = deps.now();
    const testers = deps.store.listTesters(r.id);
    const activeInvites = deps.store
      .listInvites(r.id)
      .filter((i) => i.revokedAt === null && i.expiresAt > now);
    const canEdit = ctx.membership.role !== "viewer";
    const open = r.state !== "revoked" && r.state !== "expired" && r.kind === "build";
    const history = deps.store.listAudit({ workspaceId: ctx.session.workspaceId, target: r.id, limit: 50 });
    return (
      <Layout title={`${project.name} ${r.version}`} user={navUser(ctx)}>
        <p class="crumbs">
          <a href="/">Projects</a> / <a href={`/projects/${project.id}`}>{project.name}</a>
        </p>
        <div class="title-row">
          <h1>
            {project.name} <code>{r.version}</code>
          </h1>
          <StateBadge state={r.state} />
        </div>
        <p class="lede">{r.stateDetail}</p>
        {p.ok ? <Alert tone="ok">{p.ok}</Alert> : null}
        {p.error ? <Alert tone="error">{p.error}</Alert> : null}

        <dl class="facts">
          <div>
            <dt>Published</dt>
            <dd>
              <Time ms={r.createdAt} /> by {r.createdBy}
            </dd>
          </div>
          <div>
            <dt>Test window</dt>
            <dd>
              {open ? (
                <>
                  until <Time ms={r.expiresAt} /> (<Remaining until={r.expiresAt} now={now} />)
                </>
              ) : (
                <span class="muted">closed</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Package</dt>
            <dd>
              {(r.sizeBytes / 1024).toFixed(1)} KB, <a href={`/releases/${r.id}/artifact`}>download</a>
            </dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd>
              <code class="break mono-sm">{r.sha256}</code>
            </dd>
          </div>
          <div>
            <dt>Last status check</dt>
            <dd>{r.lastSyncAt ? <Time ms={r.lastSyncAt} /> : <span class="muted">not yet</span>}</dd>
          </div>
          {r.notes ? (
            <div>
              <dt>Notes</dt>
              <dd>{r.notes}</dd>
            </div>
          ) : null}
        </dl>

        {open && canEdit ? (
          <section class="panel">
            <h2>Share link</h2>
            {p.inviteUrl ? (
              <>
                <Alert tone="ok">
                  New link created. Copy it now: it is shown only once and every earlier link stopped working.
                </Alert>
                <label for="invite-url" class="sr-only">
                  Share link
                </label>
                <input id="invite-url" class="copy-field" readonly value={p.inviteUrl} />
              </>
            ) : (
              <p>
                {activeInvites.length > 0
                  ? `A link is active until ${activeInvites.map((i) => new Date(i.expiresAt).toISOString().slice(0, 16).replace("T", " ")).join(", ")} UTC. Links are shown only when created.`
                  : "No active link."}
              </p>
            )}
            <form method="post" action={`/releases/${r.id}/invite`} class="inline-form">
              <Csrf token={ctx.session.csrf} />
              <button type="submit" class="btn">
                {activeInvites.length > 0 ? "Replace link" : "Create link"}
              </button>
              <span class="hint">
                Testers open the link, sign in with Google, and get the Web Store install button if they are
                on the list.
              </span>
            </form>
          </section>
        ) : null}

        <section class="panel">
          <h2>Testers ({testers.length})</h2>
          {project.visibility === "private" ? (
            <p class="hint">
              Private items install only for Google accounts on the item's trusted-tester list. Keep this list
              in sync with the Developer Dashboard (or a Google Group added there); the Web Store API cannot
              change it.
            </p>
          ) : testers.length === 0 ? (
            <p class="hint">
              Unlisted with no list: any signed-in Google account holding the link can see the install button.
            </p>
          ) : null}
          {testers.length === 0 ? (
            <p class="muted">Nobody yet.</p>
          ) : (
            <ul class="tester-list">
              {testers.map((t) => (
                <li>
                  <span>{t.email}</span>
                  {canEdit ? (
                    <form method="post" action={`/releases/${r.id}/testers`} class="inline">
                      <Csrf token={ctx.session.csrf} />
                      <input type="hidden" name="remove" value={t.email} />
                      <button type="submit" class="btn-link">
                        Remove
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canEdit && open ? (
            <form method="post" action={`/releases/${r.id}/testers`} class="stack">
              <Csrf token={ctx.session.csrf} />
              <Field
                label="Add testers"
                name="add"
                hint="Google account emails, separated by commas or new lines."
              >
                <textarea id="f-add" name="add" rows={2} />
              </Field>
              <div>
                <button type="submit" class="btn">
                  Add
                </button>
              </div>
            </form>
          ) : null}
        </section>

        {canEdit && open ? (
          <section class="panel two-col">
            <form method="post" action={`/releases/${r.id}/extend`} class="stack">
              <h2>Extend window</h2>
              <Csrf token={ctx.session.csrf} />
              <Field
                label="New window from now"
                name="ttl"
                value="7d"
                hint="Examples: 12h, 3d, 1d12h. Maximum 90d."
              />
              <div>
                <button type="submit" class="btn">
                  Extend
                </button>
              </div>
            </form>
            <form method="post" action={`/releases/${r.id}/sync`} class="stack">
              <h2>Web Store status</h2>
              <p class="hint">Status is checked automatically every few minutes.</p>
              <Csrf token={ctx.session.csrf} />
              <div>
                <button type="submit" class="btn">
                  Check now
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {canEdit && r.state !== "revoked" && r.kind === "build" ? (
          <section class="panel panel-danger">
            <h2>Revoke</h2>
            <p>
              Revoking disables every share link at once. Copies already installed keep working until removed
              or replaced.
            </p>
            <form method="post" action={`/releases/${r.id}/revoke`} class="stack">
              <Csrf token={ctx.session.csrf} />
              <Field label="Reason (kept in the audit log)" name="reason" />
              <label class="check">
                <input type="checkbox" name="cancelSubmission" value="1" checked /> Cancel the Web Store
                submission if it is still in review
              </label>
              <label class="check">
                <input type="checkbox" name="killSwitch" value="1" /> Kill switch: publish an empty successor
                version so installed copies update to a disabled build (goes through Web Store review, affects
                every user of this item)
              </label>
              <div>
                <button type="submit" class="btn btn-danger">
                  Revoke release
                </button>
              </div>
            </form>
          </section>
        ) : null}

        <section class="panel">
          <h2>Validation</h2>
          <Findings findings={r.findings} />
        </section>

        <section class="panel">
          <h2>History</h2>
          <AuditTable rows={history} />
        </section>
      </Layout>
    );
  };

  const loadRelease = (c: Context<Env>) =>
    releases.getRelease(actorFromSession(c.get("ctx"), clientIp(c, deps)), c.req.param("id")!);

  guarded.get("/releases/:id", (c) => {
    const { release, project } = loadRelease(c);
    return c.html(<ReleasePage ctx={c.get("ctx")} release={release} project={project} ok={notice(c)} />);
  });

  const releaseError = (c: Context<Env>) => (msg: string) => {
    const { release, project } = loadRelease(c);
    return c.html(<ReleasePage ctx={c.get("ctx")} release={release} project={project} error={msg} />);
  };
  const actor = (c: Context<Env>) => actorFromSession(c.get("ctx"), clientIp(c, deps));
  const emails = (s: string | undefined) => (s ?? "").split(/[\s,;]+/).filter(Boolean);

  guarded.post("/releases/:id/invite", async (c) => {
    try {
      await form(c, c.get("ctx"));
      const inv = releases.rotateInvite(actor(c), c.req.param("id"), {});
      const { release, project } = loadRelease(c);
      // Rendered directly (not redirected) because the raw token exists only in this response.
      c.header("cache-control", "no-store");
      return c.html(
        <ReleasePage ctx={c.get("ctx")} release={release} project={project} inviteUrl={inv.url} />,
      );
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      c.status(400);
      return releaseError(c)(e.message);
    }
  });

  guarded.post("/releases/:id/testers", (c) =>
    action(
      c,
      (f) => {
        releases.changeTesters(actor(c), c.req.param("id"), { add: emails(f.add), remove: emails(f.remove) });
        return `/releases/${c.req.param("id")}?ok=testers`;
      },
      releaseError(c),
    ),
  );

  guarded.post("/releases/:id/extend", (c) =>
    action(
      c,
      (f) => {
        releases.extend(actor(c), c.req.param("id"), { ttl: (f.ttl ?? "").trim() });
        return `/releases/${c.req.param("id")}?ok=extended`;
      },
      releaseError(c),
    ),
  );

  guarded.post("/releases/:id/sync", (c) =>
    action(
      c,
      async () => {
        await releases.sync(actor(c), c.req.param("id"));
        return `/releases/${c.req.param("id")}?ok=synced`;
      },
      releaseError(c),
    ),
  );

  guarded.post("/releases/:id/revoke", (c) =>
    action(
      c,
      async (f) => {
        const r = await releases.revoke(actor(c), c.req.param("id"), {
          reason: f.reason ?? "",
          cancelSubmission: f.cancelSubmission === "1",
          killSwitch: f.killSwitch === "1",
        });
        return r.withdrawal
          ? `/releases/${r.withdrawal.id}?ok=killswitch`
          : `/releases/${r.release.id}?ok=revoked`;
      },
      releaseError(c),
    ),
  );

  guarded.get("/releases/:id/artifact", async (c) => {
    const { release } = loadRelease(c);
    const bytes = await deps.artifacts.get(release.sha256);
    if (!bytes) throw new AppError(404, "not_found", "Artifact missing from storage");
    return new Response(bytes, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${release.id}-${release.version}.zip"`,
        "cache-control": "no-store",
      },
    });
  });

  // ---------- audit ----------

  const AuditTable = (p: { rows: ReturnType<typeof deps.store.listAudit> }) =>
    p.rows.length === 0 ? (
      <p class="muted">No events recorded.</p>
    ) : (
      <table class="table table-compact">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">Event</th>
            <th scope="col">IP</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((e) => (
            <tr>
              <td>
                <Time ms={e.at} />
              </td>
              <td>{e.actor}</td>
              <td>
                <code class="mono-sm">{e.action}</code>
                {e.details && Object.keys(e.details).length ? (
                  <span class="detail">{JSON.stringify(e.details)}</span>
                ) : null}
              </td>
              <td>{e.ip ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  guarded.get("/audit", (c) => {
    const ctx = c.get("ctx");
    const rows = deps.store.listAudit({ workspaceId: ctx.session.workspaceId, limit: 300 });
    return c.html(
      <Layout title="Audit log" user={navUser(ctx)}>
        <h1>Audit log</h1>
        <p class="lede">The latest 300 events in this workspace. Entries cannot be edited or deleted.</p>
        <AuditTable rows={rows} />
      </Layout>,
    );
  });

  // ---------- CLI device approval ----------

  const DevicePage = (p: {
    ctx: SessionContext;
    code?: string;
    client?: string;
    error?: string;
    ok?: string;
  }) => (
    <Layout title="Approve CLI" user={navUser(p.ctx)} narrow>
      <h1>Approve a CLI login</h1>
      {p.ok ? <Alert tone="ok">{p.ok}</Alert> : null}
      {p.error ? <Alert tone="error">{p.error}</Alert> : null}
      {p.client && p.code ? (
        <>
          <p class="lede">
            <strong>{p.client}</strong> is asking to act as <strong>{p.ctx.user.email}</strong> in this
            workspace. Approve only if you just ran
            <code>extshare login</code> and your terminal shows the code <code>{p.code}</code>.
          </p>
          <div class="button-row">
            <form method="post" action="/device">
              <Csrf token={p.ctx.session.csrf} />
              <input type="hidden" name="code" value={p.code} />
              <input type="hidden" name="decision" value="approve" />
              <button type="submit" class="btn btn-primary">
                Approve
              </button>
            </form>
            <form method="post" action="/device">
              <Csrf token={p.ctx.session.csrf} />
              <input type="hidden" name="code" value={p.code} />
              <input type="hidden" name="decision" value="deny" />
              <button type="submit" class="btn">
                Deny
              </button>
            </form>
          </div>
        </>
      ) : p.ok ? null : (
        <form method="get" action="/device" class="stack">
          <Field label="Code shown in your terminal" name="code" hint="Format: XXXX-XXXX" value={p.code} />
          <div>
            <button type="submit" class="btn btn-primary">
              Continue
            </button>
          </div>
        </form>
      )}
    </Layout>
  );

  guarded.get("/device", (c) => {
    const ctx = c.get("ctx");
    const code = c.req.query("code");
    if (!code) return c.html(<DevicePage ctx={ctx} ok={notice(c)} />);
    const g = auth.findPendingDevice(code);
    if (!g)
      return c.html(
        <DevicePage
          ctx={ctx}
          code={code}
          error="That code is invalid or has expired. Run extshare login again."
        />,
        404,
      );
    return c.html(<DevicePage ctx={ctx} code={g.userCode} client={g.clientName} />);
  });

  guarded.post("/device", (c) =>
    action(
      c,
      (f) => {
        const approve = f.decision === "approve";
        auth.decideDevice(c.get("ctx"), f.code ?? "", approve, clientIp(c, deps));
        return `/device?ok=${approve ? "device" : "denied"}`;
      },
      (msg) => c.html(<DevicePage ctx={c.get("ctx")} error={msg} />),
    ),
  );

  app.route("/", guarded);
  return app;
}
