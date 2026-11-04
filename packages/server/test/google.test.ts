import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { CwsApiError, HttpCwsClient, RefreshTokenProvider, ServiceAccountProvider } from "../src/cws";
import { GoogleIdentityProvider, OidcError, pkceChallenge, validateIdTokenClaims } from "../src/oidc";
import { ITEM_ID } from "./helpers";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

function fakeFetch(responder: (r: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: Recorded["body"] = null;
    if (init?.body instanceof URLSearchParams) body = init.body.toString();
    else if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof Uint8Array) body = init.body;
    const rec = { url, method: init?.method ?? "GET", headers, body };
    calls.push(rec);
    return responder(rec);
  };
  return { fn, calls };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("RefreshTokenProvider", () => {
  test("posts the documented refresh_token grant and caches until near expiry", async () => {
    let t = 0;
    const f = fakeFetch(() => json({ access_token: "ya29.one", expires_in: 3600 }));
    const p = new RefreshTokenProvider(
      { clientId: "cid", clientSecret: "csec", refreshToken: "rt" },
      f.fn,
      () => t,
    );
    expect(await p.getToken()).toBe("ya29.one");
    expect(f.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(f.calls[0]!.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body as string))).toEqual({
      client_id: "cid",
      client_secret: "csec",
      refresh_token: "rt",
      grant_type: "refresh_token",
    });
    t = 3_500_000;
    await p.getToken();
    expect(f.calls).toHaveLength(1);
    t = 3_560_000; // within 60 s of expiry: refresh
    await p.getToken();
    expect(f.calls).toHaveLength(2);
  });

  test("concurrent callers share one refresh", async () => {
    const f = fakeFetch(() => json({ access_token: "x", expires_in: 3600 }));
    const p = new RefreshTokenProvider(
      { clientId: "a", clientSecret: "b", refreshToken: "c" },
      f.fn,
      () => 0,
    );
    await Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    expect(f.calls).toHaveLength(1);
  });

  test("surfaces Google's error description", async () => {
    const f = fakeFetch(() =>
      json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400),
    );
    const p = new RefreshTokenProvider(
      { clientId: "a", clientSecret: "b", refreshToken: "c" },
      f.fn,
      () => 0,
    );
    await expect(p.getToken()).rejects.toThrow("Token has been expired or revoked.");
  });
});

describe("ServiceAccountProvider", () => {
  test("sends an RS256 JWT bearer assertion with the chromewebstore scope", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const f = fakeFetch(() => json({ access_token: "sa-token", expires_in: 3600 }));
    const p = new ServiceAccountProvider(
      { client_email: "svc@proj.iam.gserviceaccount.com", private_key: pem },
      f.fn,
      () => 1_700_000_000_000,
    );
    expect(await p.getToken()).toBe("sa-token");
    const body = new URLSearchParams(f.calls[0]!.body as string);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = body.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({
      iss: "svc@proj.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/chromewebstore",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("HttpCwsClient (API v2 request shapes)", () => {
  const tokens = { getToken: async () => "tok" };
  const base = `https://chromewebstore.googleapis.com`;
  const name = `publishers/pub-123/items/${ITEM_ID}`;

  test("upload: POST raw zip to the media upload path", async () => {
    const f = fakeFetch(() => json({ name, itemId: ITEM_ID, crxVersion: "1.2", uploadState: "SUCCEEDED" }));
    const c = new HttpCwsClient("pub-123", tokens, f.fn);
    const zip = new Uint8Array([80, 75, 5, 6]);
    expect(await c.upload(ITEM_ID, zip)).toMatchObject({ uploadState: "SUCCEEDED", crxVersion: "1.2" });
    expect(f.calls[0]).toMatchObject({ url: `${base}/upload/v2/${name}:upload`, method: "POST" });
    expect(f.calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(f.calls[0]!.headers["content-type"]).toBe("application/zip");
    expect([...(f.calls[0]!.body as Uint8Array)]).toEqual([80, 75, 5, 6]);
  });

  test("publish: POST JSON publishType, flattens warnings", async () => {
    const f = fakeFetch(() =>
      json({
        name,
        itemId: ITEM_ID,
        state: "PENDING_REVIEW",
        warningInfo: { warnings: [{ reason: "R", description: "D" }] },
      }),
    );
    const c = new HttpCwsClient("pub-123", tokens, f.fn);
    expect(await c.publish(ITEM_ID, { publishType: "STAGED_PUBLISH" })).toEqual({
      state: "PENDING_REVIEW",
      warnings: [{ reason: "R", description: "D" }],
    });
    expect(f.calls[0]).toMatchObject({ url: `${base}/v2/${name}:publish`, method: "POST" });
    expect(JSON.parse(f.calls[0]!.body as string)).toEqual({ publishType: "STAGED_PUBLISH" });
  });

  test("fetchStatus: GET; cancelSubmission: POST with empty response", async () => {
    const f = fakeFetch((r) =>
      r.url.endsWith(":fetchStatus")
        ? json({ itemId: ITEM_ID, takenDown: false })
        : new Response("", { status: 200 }),
    );
    const c = new HttpCwsClient("pub-123", tokens, f.fn);
    expect(await c.fetchStatus(ITEM_ID)).toEqual({ itemId: ITEM_ID, takenDown: false });
    await c.cancelSubmission(ITEM_ID);
    expect(f.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${base}/v2/${name}:fetchStatus`,
      `POST ${base}/v2/${name}:cancelSubmission`,
    ]);
  });

  test("maps Google API errors to CwsApiError with the message", async () => {
    const f = fakeFetch(() =>
      json({ error: { code: 400, message: "The version number must be higher." } }, 400),
    );
    const c = new HttpCwsClient("pub-123", tokens, f.fn);
    const err = await c.upload(ITEM_ID, new Uint8Array([1])).catch((e) => e);
    expect(err).toBeInstanceOf(CwsApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("The version number must be higher.");
  });

  test("refuses malformed item and publisher IDs before any request", async () => {
    const f = fakeFetch(() => json({}));
    expect(() => new HttpCwsClient("bad/../id", tokens, f.fn)).toThrow();
    const c = new HttpCwsClient("pub-123", tokens, f.fn);
    await expect(c.fetchStatus("../../evil")).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});

describe("Google OIDC", () => {
  test("PKCE S256 matches the RFC 7636 Appendix B example", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("authorization URL carries every required parameter", () => {
    const idp = new GoogleIdentityProvider(
      "cid.apps.googleusercontent.com",
      "sec",
      fakeFetch(() => json({})).fn,
      () => 0,
    );
    const u = new URL(
      idp.authorizationUrl({
        state: "st",
        nonce: "no",
        codeVerifier: "v".repeat(43),
        redirectUri: "https://x.test/cb",
      }),
    );
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid.apps.googleusercontent.com",
      response_type: "code",
      scope: "openid email",
      redirect_uri: "https://x.test/cb",
      state: "st",
      nonce: "no",
      code_challenge: pkceChallenge("v".repeat(43)),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
  });

  const idToken = (claims: Record<string, unknown>) =>
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const good = {
    iss: "https://accounts.google.com",
    aud: "cid",
    exp: 2000,
    iat: 1000,
    nonce: "n",
    email: "Tester@Example.com",
    email_verified: true,
    sub: "123",
  };

  test("valid claims yield the lower-cased verified email", () => {
    expect(validateIdTokenClaims(idToken(good), { clientId: "cid", nonce: "n", nowSec: 1500 })).toEqual({
      sub: "123",
      email: "tester@example.com",
    });
    expect(
      validateIdTokenClaims(idToken({ ...good, iss: "accounts.google.com" }), {
        clientId: "cid",
        nonce: "n",
        nowSec: 1500,
      }).sub,
    ).toBe("123");
  });

  const bad: [string, Record<string, unknown>][] = [
    ["wrong issuer", { iss: "https://evil.example" }],
    ["wrong audience", { aud: "other" }],
    ["multi-aud without azp", { aud: ["cid", "other"] }],
    ["expired", { exp: 1500 }],
    ["issued in the future", { iat: 9999 }],
    ["nonce mismatch", { nonce: "x" }],
    ["unverified email", { email_verified: false }],
    ["missing email", { email: undefined }],
    ["missing sub", { sub: undefined }],
  ];
  for (const [label, override] of bad) {
    test(`rejects ${label}`, () => {
      expect(() =>
        validateIdTokenClaims(idToken({ ...good, ...override }), {
          clientId: "cid",
          nonce: "n",
          nowSec: 1500,
        }),
      ).toThrow(OidcError);
    });
  }
  test("rejects malformed tokens", () => {
    expect(() => validateIdTokenClaims("a.b", { clientId: "cid", nonce: "n", nowSec: 1 })).toThrow(OidcError);
    expect(() => validateIdTokenClaims("a.!!!.c", { clientId: "cid", nonce: "n", nowSec: 1 })).toThrow(
      OidcError,
    );
  });

  test("exchange posts code + verifier and validates the returned ID token", async () => {
    const f = fakeFetch(() => json({ id_token: idToken(good), access_token: "at" }));
    const idp = new GoogleIdentityProvider("cid", "sec", f.fn, () => 1_500_000);
    const id = await idp.exchange({
      code: "c0de",
      codeVerifier: "ver",
      redirectUri: "https://x.test/cb",
      nonce: "n",
    });
    expect(id.email).toBe("tester@example.com");
    expect(f.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body as string))).toEqual({
      code: "c0de",
      client_id: "cid",
      client_secret: "sec",
      redirect_uri: "https://x.test/cb",
      grant_type: "authorization_code",
      code_verifier: "ver",
    });
  });

  test("exchange failure is an OidcError", async () => {
    const idp = new GoogleIdentityProvider(
      "cid",
      "sec",
      fakeFetch(() => json({ error: "invalid_grant" }, 400)).fn,
      () => 0,
    );
    await expect(
      idp.exchange({ code: "x", codeVerifier: "y", redirectUri: "z", nonce: "n" }),
    ).rejects.toThrow(OidcError);
  });
});
