import { createHash } from "node:crypto";
import type { FetchFn } from "./cws";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface VerifiedIdentity {
  sub: string;
  email: string;
}

export interface IdentityProvider {
  authorizationUrl(p: { state: string; nonce: string; codeVerifier: string; redirectUri: string }): string;
  exchange(p: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    nonce: string;
  }): Promise<VerifiedIdentity>;
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Checks the claims of an ID token received directly from Google's token endpoint over TLS.
 * Per OpenID Connect Core 3.1.3.7 (6) the TLS server validation substitutes for signature
 * checking in this flow, so only the claims are validated here.
 */
export function validateIdTokenClaims(
  idToken: string,
  p: { clientId: string; nonce: string; nowSec: number },
): VerifiedIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OidcError("Malformed ID token");
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new OidcError("Malformed ID token payload");
  }
  if (!GOOGLE_ISSUERS.has(c.iss as string)) throw new OidcError("ID token issuer is not Google");
  const aud = c.aud;
  if (!(aud === p.clientId || (Array.isArray(aud) && aud.includes(p.clientId))))
    throw new OidcError("ID token audience mismatch");
  if (Array.isArray(aud) && aud.length > 1 && c.azp !== p.clientId)
    throw new OidcError("ID token authorized party mismatch");
  if (typeof c.exp !== "number" || c.exp <= p.nowSec) throw new OidcError("ID token expired");
  if (typeof c.iat === "number" && c.iat > p.nowSec + 300)
    throw new OidcError("ID token issued in the future");
  if (c.nonce !== p.nonce) throw new OidcError("ID token nonce mismatch");
  if (typeof c.email !== "string" || c.email.length === 0)
    throw new OidcError("Google did not return an email address");
  if (c.email_verified !== true && c.email_verified !== "true")
    throw new OidcError("Google email address is not verified");
  if (typeof c.sub !== "string") throw new OidcError("ID token has no subject");
  return { sub: c.sub, email: c.email.toLowerCase() };
}

/** Google OpenID Connect sign-in for testers: authorization code flow with PKCE and nonce. */
export class GoogleIdentityProvider implements IdentityProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchFn: FetchFn,
    private readonly now: () => number,
  ) {}

  authorizationUrl(p: { state: string; nonce: string; codeVerifier: string; redirectUri: string }) {
    const q = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      scope: "openid email",
      redirect_uri: p.redirectUri,
      state: p.state,
      nonce: p.nonce,
      code_challenge: pkceChallenge(p.codeVerifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return `${GOOGLE_AUTH_URL}?${q}`;
  }

  async exchange(p: { code: string; codeVerifier: string; redirectUri: string; nonce: string }) {
    const res = await this.fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: p.code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: p.redirectUri,
        grant_type: "authorization_code",
        code_verifier: p.codeVerifier,
      }),
    });
    if (!res.ok) throw new OidcError(`Google token exchange failed (HTTP ${res.status})`);
    const j = (await res.json()) as { id_token?: string };
    if (!j.id_token) throw new OidcError("Google returned no ID token");
    return validateIdTokenClaims(j.id_token, {
      clientId: this.clientId,
      nonce: p.nonce,
      nowSec: Math.floor(this.now() / 1000),
    });
  }
}
