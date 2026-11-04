import type { ReleaseState } from "@extshare/core";
import type {
  ApiToken,
  AuditEntry,
  DeviceGrant,
  Invite,
  Membership,
  Project,
  Release,
  ReleaseTester,
  Session,
  Store,
  TesterSession,
  User,
  Workspace,
} from "./types";

class UniqueViolation extends Error {
  constructor(what: string) {
    super(`Unique constraint violated: ${what}`);
    this.name = "UniqueViolation";
  }
}

const copy = <T>(v: T): T => structuredClone(v);

/**
 * In-process Store for tests and ephemeral runs. Enforces the same uniqueness rules as the
 * SQLite schema and copies on every read and write so callers cannot alias stored state.
 */
export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private workspaces = new Map<string, Workspace>();
  private members: Membership[] = [];
  private sessions = new Map<string, Session>();
  private tokens = new Map<string, ApiToken>();
  private grants = new Map<string, DeviceGrant>();
  private projects = new Map<string, Project>();
  private releases = new Map<string, Release>();
  private testers: ReleaseTester[] = [];
  private invites = new Map<string, Invite>();
  private testerSessions = new Map<string, TesterSession>();
  private audit: AuditEntry[] = [];

  transaction<T>(fn: () => T): T {
    const snapshot = this.snapshot();
    try {
      return fn();
    } catch (e) {
      Object.assign(this, snapshot);
      throw e;
    }
  }

  private snapshot() {
    return copy({
      users: this.users,
      workspaces: this.workspaces,
      members: this.members,
      sessions: this.sessions,
      tokens: this.tokens,
      grants: this.grants,
      projects: this.projects,
      releases: this.releases,
      testers: this.testers,
      invites: this.invites,
      testerSessions: this.testerSessions,
      audit: this.audit,
    });
  }

  private insert<T>(map: Map<string, T>, key: string, value: T, what: string) {
    if (map.has(key)) throw new UniqueViolation(what);
    map.set(key, copy(value));
  }

  private patch<T extends object>(map: Map<string, T>, key: string, patch: Partial<T>) {
    const cur = map.get(key);
    if (cur) map.set(key, { ...cur, ...copy(patch) });
  }

  createUser(u: User) {
    if (this.getUserByEmail(u.email)) throw new UniqueViolation("users.email");
    this.insert(this.users, u.id, u, "users.id");
  }
  getUser(id: string) {
    const u = this.users.get(id);
    return u ? copy(u) : null;
  }
  getUserByEmail(email: string) {
    for (const u of this.users.values()) if (u.email === email) return copy(u);
    return null;
  }
  updateUser(id: string, patch: Partial<User>) {
    this.patch(this.users, id, patch);
  }

  createWorkspace(w: Workspace) {
    this.insert(this.workspaces, w.id, w, "workspaces.id");
  }
  getWorkspace(id: string) {
    const w = this.workspaces.get(id);
    return w ? copy(w) : null;
  }
  addMember(m: Membership) {
    if (this.getMembership(m.workspaceId, m.userId)) throw new UniqueViolation("memberships");
    this.members.push(copy(m));
  }
  getMembership(workspaceId: string, userId: string) {
    const m = this.members.find((x) => x.workspaceId === workspaceId && x.userId === userId);
    return m ? copy(m) : null;
  }
  listMemberships(userId: string) {
    return this.members.filter((m) => m.userId === userId).map(copy);
  }

  createSession(s: Session) {
    this.insert(this.sessions, s.idHash, s, "sessions.id_hash");
  }
  getSession(idHash: string) {
    const s = this.sessions.get(idHash);
    return s ? copy(s) : null;
  }
  updateSession(idHash: string, patch: Partial<Session>) {
    this.patch(this.sessions, idHash, patch);
  }
  deleteSession(idHash: string) {
    this.sessions.delete(idHash);
  }
  deleteSessionsForUser(userId: string) {
    for (const [k, s] of this.sessions) if (s.userId === userId) this.sessions.delete(k);
  }

  createToken(t: ApiToken) {
    this.insert(this.tokens, t.hash, t, "api_tokens.hash");
  }
  getToken(hash: string) {
    const t = this.tokens.get(hash);
    return t ? copy(t) : null;
  }
  claimRefreshToken(hash: string, at: number) {
    const t = this.tokens.get(hash);
    if (t?.kind !== "refresh" || t.usedAt !== null || t.revokedAt !== null) return false;
    this.tokens.set(hash, { ...t, usedAt: at });
    return true;
  }
  revokeToken(hash: string, at: number) {
    const t = this.tokens.get(hash);
    if (t && t.revokedAt === null) this.tokens.set(hash, { ...t, revokedAt: at });
  }
  revokeTokenFamily(family: string, at: number) {
    for (const [k, t] of this.tokens)
      if (t.family === family && t.revokedAt === null) this.tokens.set(k, { ...t, revokedAt: at });
  }
  revokeTokensForUser(userId: string, at: number) {
    for (const [k, t] of this.tokens)
      if (t.userId === userId && t.revokedAt === null) this.tokens.set(k, { ...t, revokedAt: at });
  }

  createDeviceGrant(g: DeviceGrant) {
    if (this.getDeviceGrantByUserCode(g.userCode)) throw new UniqueViolation("device_grants.user_code");
    for (const x of this.grants.values())
      if (x.deviceCodeHash === g.deviceCodeHash) throw new UniqueViolation("device_grants.device_code_hash");
    this.insert(this.grants, g.id, g, "device_grants.id");
  }
  getDeviceGrantByCodeHash(hash: string) {
    for (const g of this.grants.values()) if (g.deviceCodeHash === hash) return copy(g);
    return null;
  }
  getDeviceGrantByUserCode(userCode: string) {
    for (const g of this.grants.values()) if (g.userCode === userCode) return copy(g);
    return null;
  }
  updateDeviceGrant(id: string, patch: Partial<DeviceGrant>) {
    this.patch(this.grants, id, patch);
  }

  createProject(p: Project) {
    if (this.getProjectByItemId(p.itemId)) throw new UniqueViolation("projects.item_id");
    this.insert(this.projects, p.id, p, "projects.id");
  }
  getProject(id: string) {
    const p = this.projects.get(id);
    return p ? copy(p) : null;
  }
  getProjectByItemId(itemId: string) {
    for (const p of this.projects.values()) if (p.itemId === itemId) return copy(p);
    return null;
  }
  listProjects(workspaceId: string) {
    return [...this.projects.values()]
      .filter((p) => p.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map(copy);
  }

  createRelease(r: Release) {
    this.insert(this.releases, r.id, r, "releases.id");
  }
  getRelease(id: string) {
    const r = this.releases.get(id);
    return r ? copy(r) : null;
  }
  updateRelease(id: string, patch: Partial<Release>) {
    this.patch(this.releases, id, patch);
  }
  listReleases(projectId: string) {
    return [...this.releases.values()]
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map(copy);
  }
  listReleasesInStates(states: readonly ReleaseState[]) {
    const set = new Set(states);
    return [...this.releases.values()]
      .filter((r) => set.has(r.state))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(copy);
  }

  addTesters(rows: ReleaseTester[]) {
    for (const row of rows) {
      if (!this.testers.some((t) => t.releaseId === row.releaseId && t.email === row.email))
        this.testers.push(copy(row));
    }
  }
  removeTesters(releaseId: string, emails: string[]) {
    const drop = new Set(emails);
    this.testers = this.testers.filter((t) => !(t.releaseId === releaseId && drop.has(t.email)));
  }
  listTesters(releaseId: string) {
    return this.testers
      .filter((t) => t.releaseId === releaseId)
      .sort((a, b) => a.email.localeCompare(b.email))
      .map(copy);
  }

  createInvite(i: Invite) {
    for (const x of this.invites.values())
      if (x.tokenHash === i.tokenHash) throw new UniqueViolation("invites.token_hash");
    this.insert(this.invites, i.id, i, "invites.id");
  }
  getInviteByTokenHash(hash: string) {
    for (const i of this.invites.values()) if (i.tokenHash === hash) return copy(i);
    return null;
  }
  listInvites(releaseId: string) {
    return [...this.invites.values()]
      .filter((i) => i.releaseId === releaseId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map(copy);
  }
  revokeInvites(releaseId: string, at: number) {
    for (const [k, i] of this.invites)
      if (i.releaseId === releaseId && i.revokedAt === null) this.invites.set(k, { ...i, revokedAt: at });
  }

  extendInvites(releaseId: string, from: number, to: number) {
    for (const [k, i] of this.invites) {
      if (i.releaseId === releaseId && i.revokedAt === null && i.expiresAt === from)
        this.invites.set(k, { ...i, expiresAt: to });
    }
  }

  createTesterSession(s: TesterSession) {
    this.insert(this.testerSessions, s.idHash, s, "tester_sessions.id_hash");
  }
  getTesterSession(idHash: string) {
    const s = this.testerSessions.get(idHash);
    return s ? copy(s) : null;
  }
  deleteTesterSession(idHash: string) {
    this.testerSessions.delete(idHash);
  }

  appendAudit(e: AuditEntry) {
    this.audit.push(copy(e));
  }
  listAudit(q: { workspaceId: string; target?: string; limit: number }) {
    return this.audit
      .filter((e) => e.workspaceId === q.workspaceId && (q.target === undefined || e.target === q.target))
      .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
      .slice(0, q.limit)
      .map(copy);
  }

  purgeExpired(now: number) {
    let n = 0;
    for (const [k, s] of this.sessions) if (s.expiresAt <= now && this.sessions.delete(k)) n++;
    for (const [k, t] of this.tokens) if (t.expiresAt <= now && this.tokens.delete(k)) n++;
    for (const [k, g] of this.grants) if (g.expiresAt <= now && this.grants.delete(k)) n++;
    for (const [k, s] of this.testerSessions) if (s.expiresAt <= now && this.testerSessions.delete(k)) n++;
    return n;
  }
}
