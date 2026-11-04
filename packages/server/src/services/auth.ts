import { type DeviceStartDto, isValidEmail, normalizeEmail, type TokenDto } from "@extshare/core";
import { type Actor, AppError, type Deps } from "../context";
import {
  hashToken,
  newId,
  newTotpSecret,
  newUserCode,
  normalizeUserCode,
  randomToken,
  verifyTotp,
} from "../security";
import type { Membership, Role, Session, User } from "../store/types";
import { audit } from "./audit";

export const SESSION_TTL_MS = 12 * 3_600_000;
export const ACCESS_TTL_MS = 3_600_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
export const DEVICE_TTL_MS = 10 * 60_000;
export const DEVICE_INTERVAL_SEC = 5;
export const MIN_PASSWORD_LENGTH = 12;

// Verified against when the email is unknown, so a missing account costs the same time as a wrong password.
const DUMMY_HASH = Bun.password.hashSync("extshare-timing-equaliser", { algorithm: "argon2id" });

export interface SessionContext {
  session: Session;
  user: User;
  membership: Membership;
}

export class AuthService {
  constructor(private readonly deps: Deps) {}

  /** Bootstrap path used by the admin CLI. */
  async createUser(input: {
    email: string;
    name: string;
    password: string;
    workspaceName?: string;
    workspaceId?: string;
    role: Role;
  }) {
    const { store, now } = this.deps;
    const email = normalizeEmail(input.email);
    if (!isValidEmail(email)) throw new AppError(400, "invalid_email", "Invalid email address");
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError(400, "weak_password", `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (store.getUserByEmail(email))
      throw new AppError(409, "user_exists", `A user with email ${email} already exists`);
    const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
    return store.transaction(() => {
      let workspaceId = input.workspaceId;
      if (workspaceId) {
        if (!store.getWorkspace(workspaceId))
          throw new AppError(404, "workspace_not_found", "Workspace not found");
      } else {
        if (!input.workspaceName)
          throw new AppError(400, "workspace_required", "Give a workspace name or ID");
        workspaceId = newId("ws");
        store.createWorkspace({ id: workspaceId, name: input.workspaceName, createdAt: now() });
      }
      const user: User = {
        id: newId("usr"),
        email,
        name: input.name.trim() || email,
        passwordHash,
        totpSecret: null,
        totpEnabled: false,
        totpLastStep: 0,
        disabled: false,
        createdAt: now(),
      };
      store.createUser(user);
      store.addMember({ workspaceId, userId: user.id, role: input.role });
      audit(this.deps, {
        workspaceId,
        actor: "admin-cli",
        action: "user.created",
        target: user.id,
        details: { email, role: input.role },
      });
      return { userId: user.id, workspaceId };
    });
  }

  /** Resets MFA so the user enrolls again at next login; also ends their sessions and CLI tokens. */
  resetMfa(email: string) {
    const { store, now } = this.deps;
    const user = store.getUserByEmail(normalizeEmail(email));
    if (!user) throw new AppError(404, "user_not_found", "No such user");
    store.transaction(() => {
      store.updateUser(user.id, { totpSecret: null, totpEnabled: false, totpLastStep: 0 });
      store.deleteSessionsForUser(user.id);
      store.revokeTokensForUser(user.id, now());
    });
  }

  async passwordLogin(
    email: string,
    password: string,
    ip: string | null,
  ): Promise<{ sessionId: string; session: Session }> {
    const { store, now, limiter } = this.deps;
    const norm = normalizeEmail(email);
    if (
      !limiter.take(`login-ip:${ip}`, 20, 15 * 60_000) ||
      !limiter.take(`login-user:${norm}`, 8, 15 * 60_000)
    ) {
      throw new AppError(429, "rate_limited", "Too many sign-in attempts. Wait 15 minutes and try again.");
    }
    const user = store.getUserByEmail(norm);
    const ok = await Bun.password.verify(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || user.disabled) {
      audit(this.deps, {
        workspaceId: null,
        actor: norm,
        action: "login.failed",
        target: user?.id ?? "unknown",
        ip,
      });
      throw new AppError(401, "invalid_credentials", "Email or password is incorrect");
    }
    const membership = store.listMemberships(user.id)[0];
    if (!membership) throw new AppError(403, "no_workspace", "Your account is not a member of any workspace");
    const sessionId = randomToken();
    const session: Session = {
      idHash: hashToken(sessionId),
      userId: user.id,
      workspaceId: membership.workspaceId,
      mfaPassed: false,
      csrf: randomToken(24),
      createdAt: now(),
      expiresAt: now() + SESSION_TTL_MS,
    };
    store.createSession(session);
    audit(this.deps, {
      workspaceId: membership.workspaceId,
      actor: user.email,
      action: "login.password_ok",
      target: user.id,
      ip,
    });
    return { sessionId, session };
  }

  /** Resolves a session cookie. With `requireMfa`, a session that has not passed TOTP is treated as absent. */
  resolveSession(sessionId: string | undefined, requireMfa: boolean): SessionContext | null {
    if (!sessionId) return null;
    const { store, now } = this.deps;
    const session = store.getSession(hashToken(sessionId));
    if (!session || session.expiresAt <= now()) return null;
    if (requireMfa && !session.mfaPassed) return null;
    const user = store.getUser(session.userId);
    if (!user || user.disabled) return null;
    const membership = store.getMembership(session.workspaceId, user.id);
    if (!membership) return null;
    return { session, user, membership };
  }

  beginTotpSetup(ctx: SessionContext): string {
    if (ctx.user.totpEnabled)
      throw new AppError(409, "mfa_enabled", "Two-factor authentication is already set up");
    if (ctx.user.totpSecret) return ctx.user.totpSecret;
    const secret = newTotpSecret();
    this.deps.store.updateUser(ctx.user.id, { totpSecret: secret });
    return secret;
  }

  /** Verifies a TOTP code for the session's user, enabling MFA if this is enrolment, and marks the session MFA-passed. */
  verifyTotpForSession(ctx: SessionContext, code: string, ip: string | null) {
    const { store, now, limiter } = this.deps;
    if (!limiter.take(`totp:${ctx.user.id}`, 6, 5 * 60_000)) {
      throw new AppError(429, "rate_limited", "Too many codes tried. Wait 5 minutes.");
    }
    const user = store.getUser(ctx.user.id);
    if (!user?.totpSecret)
      throw new AppError(409, "mfa_not_started", "Set up two-factor authentication first");
    const step = verifyTotp(user.totpSecret, code.replace(/\s/g, ""), now(), user.totpLastStep);
    if (step === null) {
      audit(this.deps, {
        workspaceId: ctx.session.workspaceId,
        actor: user.email,
        action: "mfa.failed",
        target: user.id,
        ip,
      });
      throw new AppError(
        401,
        "invalid_code",
        "That code is not valid. Check your authenticator app's clock.",
      );
    }
    store.transaction(() => {
      store.updateUser(user.id, { totpLastStep: step, totpEnabled: true });
      store.updateSession(ctx.session.idHash, { mfaPassed: true });
    });
    audit(this.deps, {
      workspaceId: ctx.session.workspaceId,
      actor: user.email,
      action: user.totpEnabled ? "mfa.ok" : "mfa.enrolled",
      target: user.id,
      ip,
    });
  }

  switchWorkspace(ctx: SessionContext, workspaceId: string) {
    if (!this.deps.store.getMembership(workspaceId, ctx.user.id))
      throw new AppError(403, "forbidden", "Not a member of that workspace");
    this.deps.store.updateSession(ctx.session.idHash, { workspaceId });
  }

  logout(sessionId: string | undefined) {
    if (sessionId) this.deps.store.deleteSession(hashToken(sessionId));
  }

  // ---- Device authorization (RFC 8628 style) for the CLI ----

  startDevice(clientName: string, ip: string | null): DeviceStartDto {
    const { store, now, limiter, config } = this.deps;
    if (!limiter.take(`device-start:${ip}`, 10, 10 * 60_000))
      throw new AppError(429, "rate_limited", "Too many login attempts");
    const deviceCode = randomToken();
    const userCode = newUserCode();
    store.createDeviceGrant({
      id: newId("dev"),
      deviceCodeHash: hashToken(deviceCode),
      userCode,
      status: "pending",
      userId: null,
      workspaceId: null,
      clientName: clientName.slice(0, 80),
      createdAt: now(),
      expiresAt: now() + DEVICE_TTL_MS,
      lastPollAt: 0,
    });
    return {
      deviceCode,
      userCode,
      verificationUri: `${config.publicUrl}/device`,
      verificationUriComplete: `${config.publicUrl}/device?code=${encodeURIComponent(userCode)}`,
      intervalSec: DEVICE_INTERVAL_SEC,
      expiresInSec: DEVICE_TTL_MS / 1000,
    };
  }

  findPendingDevice(userCodeInput: string) {
    const g = this.deps.store.getDeviceGrantByUserCode(normalizeUserCode(userCodeInput));
    if (g?.status !== "pending" || g.expiresAt <= this.deps.now()) return null;
    return g;
  }

  decideDevice(ctx: SessionContext, userCodeInput: string, approve: boolean, ip: string | null) {
    const g = this.findPendingDevice(userCodeInput);
    if (!g)
      throw new AppError(
        404,
        "invalid_code",
        "That code is invalid or has expired. Run `extshare login` again.",
      );
    this.deps.store.updateDeviceGrant(g.id, {
      status: approve ? "approved" : "denied",
      userId: ctx.user.id,
      workspaceId: ctx.session.workspaceId,
    });
    audit(this.deps, {
      workspaceId: ctx.session.workspaceId,
      actor: ctx.user.email,
      action: approve ? "device.approved" : "device.denied",
      target: g.id,
      ip,
      details: { client: g.clientName },
    });
  }

  pollDevice(deviceCode: string): TokenDto | { pending: true; slowDown?: boolean } {
    const { store, now } = this.deps;
    const g = store.getDeviceGrantByCodeHash(hashToken(deviceCode));
    if (!g || g.status === "consumed")
      throw new AppError(400, "invalid_grant", "Unknown or already-used device code");
    if (g.expiresAt <= now())
      throw new AppError(410, "expired_token", "Login request expired; run `extshare login` again");
    if (g.status === "denied") throw new AppError(403, "access_denied", "Login was denied in the browser");
    if (g.status === "pending") {
      const tooFast = now() - g.lastPollAt < DEVICE_INTERVAL_SEC * 1000 - 250;
      store.updateDeviceGrant(g.id, { lastPollAt: now() });
      return tooFast ? { pending: true, slowDown: true } : { pending: true };
    }
    // Approved: consume exactly once, even if two polls race.
    return store.transaction(() => {
      const fresh = store.getDeviceGrantByCodeHash(g.deviceCodeHash);
      if (fresh?.status !== "approved" || !fresh.userId || !fresh.workspaceId) {
        throw new AppError(400, "invalid_grant", "Device code already used");
      }
      store.updateDeviceGrant(g.id, { status: "consumed" });
      const tokens = this.issueTokens(fresh.userId, fresh.workspaceId, newId("fam"));
      audit(this.deps, {
        workspaceId: fresh.workspaceId,
        actor: fresh.userId,
        action: "token.issued",
        target: g.id,
        details: { client: g.clientName },
      });
      return tokens;
    });
  }

  private issueTokens(userId: string, workspaceId: string, family: string): TokenDto {
    const { store, now } = this.deps;
    const accessToken = `xsa_${randomToken()}`;
    const refreshToken = `xsr_${randomToken()}`;
    const base = { userId, workspaceId, family, createdAt: now(), revokedAt: null, usedAt: null };
    store.createToken({
      ...base,
      hash: hashToken(accessToken),
      kind: "access",
      expiresAt: now() + ACCESS_TTL_MS,
    });
    store.createToken({
      ...base,
      hash: hashToken(refreshToken),
      kind: "refresh",
      expiresAt: now() + REFRESH_TTL_MS,
    });
    return { accessToken, refreshToken, expiresAt: now() + ACCESS_TTL_MS };
  }

  /** Rotates a refresh token. Presenting an already-rotated token revokes the whole family (token theft signal). */
  refresh(refreshToken: string, ip: string | null): TokenDto {
    const { store, now } = this.deps;
    const hash = hashToken(refreshToken);
    const t = store.getToken(hash);
    if (t?.kind !== "refresh" || t.expiresAt <= now())
      throw new AppError(401, "invalid_token", "Session expired; run `extshare login`");
    // The claim is atomic on its own; the revoke below must commit, so it is not inside a transaction that then throws.
    if (!store.claimRefreshToken(hash, now())) {
      store.revokeTokenFamily(t.family, now());
      if (store.getToken(hash)?.usedAt != null) {
        audit(this.deps, {
          workspaceId: t.workspaceId,
          actor: t.userId,
          action: "token.reuse_detected",
          target: t.family,
          ip,
        });
      }
      throw new AppError(401, "invalid_token", "Session revoked; run `extshare login`");
    }
    const user = store.getUser(t.userId);
    if (!user || user.disabled || !store.getMembership(t.workspaceId, t.userId)) {
      throw new AppError(401, "invalid_token", "Account no longer has access");
    }
    return store.transaction(() => this.issueTokens(t.userId, t.workspaceId, t.family));
  }

  revokeFamilyOf(accessToken: string) {
    const t = this.deps.store.getToken(hashToken(accessToken));
    if (t) this.deps.store.revokeTokenFamily(t.family, this.deps.now());
  }

  /** Resolves a CLI bearer token to an actor scoped to the workspace it was approved for. */
  authenticateBearer(token: string | undefined, ip: string | null): Actor {
    if (!token) throw new AppError(401, "unauthenticated", "Missing bearer token; run `extshare login`");
    const { store, now } = this.deps;
    const t = store.getToken(hashToken(token));
    if (t?.kind !== "access" || t.revokedAt !== null || t.expiresAt <= now()) {
      throw new AppError(401, "invalid_token", "Token expired or revoked");
    }
    const user = store.getUser(t.userId);
    const m = store.getMembership(t.workspaceId, t.userId);
    if (!user || user.disabled || !m)
      throw new AppError(401, "invalid_token", "Account no longer has access");
    return { userId: user.id, email: user.email, workspaceId: m.workspaceId, role: m.role, ip };
  }
}

export function actorFromSession(ctx: SessionContext, ip: string | null): Actor {
  return {
    userId: ctx.user.id,
    email: ctx.user.email,
    workspaceId: ctx.session.workspaceId,
    role: ctx.membership.role,
    ip,
  };
}
