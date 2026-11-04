import { type AccessDecision, webStoreUrl } from "@extshare/core";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Deps } from "../context";
import { OidcError } from "../oidc";
import { hashToken, randomToken } from "../security";
import { audit } from "../services/audit";
import type { ReleaseService } from "../services/releases";
import type { Project, Release } from "../store/types";
import { clientIp, cookieName, sameOrigin, secureCookies } from "./util";
import { Alert, Layout, STATE_LABEL, Time } from "./views";

export const TESTER_SESSION_TTL_MS = 8 * 3_600_000;
const OIDC_FLOW_TTL_MS = 10 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

interface OidcFlow {
  state: string;
  nonce: string;
  verifier: string;
  token: string;
}

const DENY_COPY: Record<
  Extract<AccessDecision, { kind: "deny" }>["reason"],
  { title: string; body: string }
> = {
  invalid_link: {
    title: "This link is not valid",
    body: "Check that you copied the whole link, or ask the publisher for a new one.",
  },
  link_revoked: {
    title: "This link was replaced",
    body: "The publisher created a newer link. Ask them to send it to you.",
  },
  link_expired: { title: "This link has expired", body: "Ask the publisher for a new link." },
  release_revoked: {
    title: "This test has ended",
    body: "The publisher withdrew this build. If it is installed, you can remove it from chrome://extensions.",
  },
  release_expired: {
    title: "This test window has closed",
    body: "The test period for this build is over. Ask the publisher if a newer build is available.",
  },
};

export function gatewayRoutes(deps: Deps, releases: ReleaseService) {
  const app = new Hono();
  const TESTER = cookieName(deps, "xs_tester");
  const FLOW = cookieName(deps, "xs_oidc");
  const redirectUri = `${deps.config.publicUrl}/auth/google/callback`;

  const testerEmail = (c: Context): string | null => {
    const id = getCookie(c, TESTER);
    if (!id) return null;
    const s = deps.store.getTesterSession(hashToken(id));
    return s && s.expiresAt > deps.now() ? s.email : null;
  };

  const SignedInAs = (p: { email: string; token: string }) => (
    <form method="post" action={`/r/${p.token}/signout`} class="signed-in">
      <span>
        Signed in as <strong>{p.email}</strong>
      </span>
      <button type="submit" class="btn-link">
        Use another account
      </button>
    </form>
  );

  const Page = (p: {
    token: string;
    decision: AccessDecision;
    release: Release | null;
    project: Project | null;
    email: string | null;
  }) => {
    const { decision: d, release, project, email, token } = p;
    if (d.kind === "deny") {
      const copy = DENY_COPY[d.reason];
      return (
        <Layout title={copy.title} narrow>
          <h1>{copy.title}</h1>
          <p class="lede">{copy.body}</p>
        </Layout>
      );
    }
    if (d.kind === "signin") {
      return (
        <Layout title="Sign in to continue" narrow>
          <h1>You're invited to test a Chrome extension</h1>
          <p class="lede">
            Sign in with the Google account the publisher invited. It should be the same account you use in
            Chrome.
          </p>
          {deps.idp ? (
            <a class="btn btn-primary" href={`/r/${token}/signin`}>
              Sign in with Google
            </a>
          ) : (
            <Alert tone="error">Tester sign-in is not configured on this server. Tell the publisher.</Alert>
          )}
        </Layout>
      );
    }
    if (d.kind === "forbidden") {
      return (
        <Layout title="Not on the tester list" narrow>
          <h1>This account isn't on the tester list</h1>
          <p class="lede">
            Ask the publisher to add your address, or switch to the Google account they invited.
          </p>
          <SignedInAs email={email!} token={token} />
        </Layout>
      );
    }
    const name = project!.name;
    if (d.kind === "pending") {
      return (
        <Layout title={`${name} is not ready yet`} narrow>
          <h1>{name} is not installable yet</h1>
          <p class="lede">
            Version <code>{release!.version}</code> is <strong>{STATE_LABEL[d.state].toLowerCase()}</strong>{" "}
            at the Chrome Web Store. Reviews usually finish within a few days. Open this link again later.
          </p>
          <SignedInAs email={email!} token={token} />
        </Layout>
      );
    }
    if (d.kind === "unavailable") {
      return (
        <Layout title={`${name} is unavailable`} narrow>
          <h1>This build is not available</h1>
          <p class="lede">
            Version <code>{release!.version}</code> is <strong>{STATE_LABEL[d.state].toLowerCase()}</strong>.
            Ask the publisher for a link to the current build.
          </p>
          <SignedInAs email={email!} token={token} />
        </Layout>
      );
    }
    return (
      <Layout title={`Install ${name}`} narrow>
        <h1>Install {name}</h1>
        <p class="lede">
          Test build <code>{release!.version}</code>, available until <Time ms={release!.expiresAt} />.
        </p>
        <a
          class="btn btn-primary btn-lg"
          href={webStoreUrl(project!.itemId)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open in Chrome Web Store
        </a>
        <ol class="steps">
          <li>Open the store page in Chrome, signed in to Chrome as {email}.</li>
          <li>Choose Add to Chrome and review the permissions Chrome lists.</li>
          <li>Updates install automatically. When the test ends, remove it from chrome://extensions.</li>
        </ol>
        {project!.visibility === "private" ? (
          <p class="hint">
            If the store says the item is unavailable, the Chrome profile is signed in to a different Google
            account than {email}.
          </p>
        ) : null}
        <SignedInAs email={email!} token={token} />
      </Layout>
    );
  };

  app.get("/r/:token", (c) => {
    const token = c.req.param("token");
    const ip = clientIp(c, deps);
    if (!deps.limiter.take(`gateway:${ip}`, 60, 60_000)) return c.text("Too many requests", 429);
    const email = testerEmail(c);
    const { decision, release, project } = releases.evaluateInvite(token, email, ip);
    c.header("cache-control", "no-store");
    const status =
      decision.kind === "deny"
        ? decision.reason === "invalid_link"
          ? 404
          : 410
        : decision.kind === "forbidden"
          ? 403
          : 200;
    return c.html(
      <Page token={token} decision={decision} release={release} project={project} email={email} />,
      status,
    );
  });

  app.get("/r/:token/signin", (c) => {
    const token = c.req.param("token");
    if (!TOKEN_RE.test(token)) return c.redirect(`/r/${encodeURIComponent(token)}`);
    if (!deps.idp) return c.text("Tester sign-in is not configured", 503);
    const flow: OidcFlow = {
      state: randomToken(16),
      nonce: randomToken(16),
      verifier: randomToken(48),
      token,
    };
    setCookie(c, FLOW, deps.signer.sign("oidc", flow, deps.now() + OIDC_FLOW_TTL_MS), {
      httpOnly: true,
      secure: secureCookies(deps),
      // Lax so the cookie survives the top-level redirect back from Google.
      sameSite: "Lax",
      path: "/",
      maxAge: OIDC_FLOW_TTL_MS / 1000,
    });
    return c.redirect(
      deps.idp.authorizationUrl({
        state: flow.state,
        nonce: flow.nonce,
        codeVerifier: flow.verifier,
        redirectUri,
      }),
    );
  });

  app.get("/auth/google/callback", async (c) => {
    const flow = deps.signer.verify<OidcFlow>("oidc", getCookie(c, FLOW), deps.now());
    deleteCookie(c, FLOW, { path: "/", secure: secureCookies(deps) });
    const ip = clientIp(c, deps);
    const fail = (msg: string, status: 400 | 502 = 400) =>
      c.html(
        <Layout title="Sign-in failed" narrow>
          <h1>Sign-in didn't complete</h1>
          <p class="lede">{msg}</p>
          {flow ? (
            <a class="btn" href={`/r/${flow.token}`}>
              Back to the invite
            </a>
          ) : null}
        </Layout>,
        status,
      );
    if (!flow || !deps.idp) return fail("Your sign-in session expired. Open the invite link again.");
    const state = c.req.query("state");
    if (!state || state !== flow.state)
      return fail("Sign-in state did not match. Open the invite link again.");
    if (c.req.query("error")) return fail("Google sign-in was cancelled.");
    const code = c.req.query("code");
    if (!code) return fail("Google did not return a sign-in code.");
    try {
      const id = await deps.idp.exchange({
        code,
        codeVerifier: flow.verifier,
        redirectUri,
        nonce: flow.nonce,
      });
      const sessionId = randomToken();
      deps.store.createTesterSession({
        idHash: hashToken(sessionId),
        email: id.email,
        createdAt: deps.now(),
        expiresAt: deps.now() + TESTER_SESSION_TTL_MS,
      });
      setCookie(c, TESTER, sessionId, {
        httpOnly: true,
        secure: secureCookies(deps),
        sameSite: "Lax",
        path: "/",
        maxAge: TESTER_SESSION_TTL_MS / 1000,
      });
      audit(deps, { workspaceId: null, actor: id.email, action: "tester.signin", target: "google", ip });
      return c.redirect(`/r/${flow.token}`);
    } catch (e) {
      if (e instanceof OidcError) return fail(e.message, 502);
      throw e;
    }
  });

  app.post("/r/:token/signout", (c) => {
    if (!sameOrigin(c, deps)) return c.text("Cross-site request refused", 403);
    const id = getCookie(c, TESTER);
    if (id) deps.store.deleteTesterSession(hashToken(id));
    deleteCookie(c, TESTER, { path: "/", secure: secureCookies(deps) });
    const token = c.req.param("token");
    return c.redirect(TOKEN_RE.test(token) ? `/r/${token}` : "/", 303);
  });

  return app;
}
