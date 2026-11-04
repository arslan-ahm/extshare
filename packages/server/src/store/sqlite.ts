import { Database } from "bun:sqlite";
import type { ReleaseState } from "@extshare/core";
import migration001 from "./migrations/001_init.sql" with { type: "text" };
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

type Row = Record<string, unknown>;
type Bindable = string | number | null;

/**
 * Ordered migrations, embedded at build time so a bundled server needs no files beside it.
 * Add new files here in order; never edit one that has shipped.
 */
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
  { name: "001_init.sql", sql: migration001 },
];

/** Applies every migration not yet recorded in schema_migrations, in order. Returns the names applied. */
export function migrate(db: Database, migrations = MIGRATIONS): string[] {
  db.run("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set(
    db
      .query("SELECT name FROM schema_migrations")
      .all()
      .map((r) => (r as Row).name as string),
  );
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    db.transaction(() => {
      db.run(m.sql);
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(m.name, Date.now());
    })();
    applied.push(m.name);
  }
  return applied;
}

const b = (v: boolean) => (v ? 1 : 0);
const camelToSnake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Columns whose names differ from the snake_case of their field, or whose values need encoding. */
const ENCODE: Record<string, (v: unknown) => [string, Bindable]> = {
  findings: (v) => ["findings_json", JSON.stringify(v)],
  details: (v) => ["details_json", JSON.stringify(v)],
};

export function encodePatch(patch: object): [string[], Bindable[]] {
  const cols: string[] = [];
  const vals: Bindable[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const enc = ENCODE[k];
    const [col, val] = enc ? enc(v) : [camelToSnake(k), typeof v === "boolean" ? b(v) : (v as Bindable)];
    cols.push(col);
    vals.push(val);
  }
  return [cols, vals];
}

const user = (r: Row): User => ({
  id: r.id as string,
  email: r.email as string,
  name: r.name as string,
  passwordHash: r.password_hash as string,
  totpSecret: (r.totp_secret as string | null) ?? null,
  totpEnabled: r.totp_enabled === 1,
  totpLastStep: r.totp_last_step as number,
  disabled: r.disabled === 1,
  createdAt: r.created_at as number,
});
const workspace = (r: Row): Workspace => ({
  id: r.id as string,
  name: r.name as string,
  createdAt: r.created_at as number,
});
const membership = (r: Row): Membership => ({
  workspaceId: r.workspace_id as string,
  userId: r.user_id as string,
  role: r.role as Membership["role"],
});
const session = (r: Row): Session => ({
  idHash: r.id_hash as string,
  userId: r.user_id as string,
  workspaceId: r.workspace_id as string,
  mfaPassed: r.mfa_passed === 1,
  csrf: r.csrf as string,
  createdAt: r.created_at as number,
  expiresAt: r.expires_at as number,
});
const token = (r: Row): ApiToken => ({
  hash: r.hash as string,
  kind: r.kind as ApiToken["kind"],
  userId: r.user_id as string,
  workspaceId: r.workspace_id as string,
  family: r.family as string,
  createdAt: r.created_at as number,
  expiresAt: r.expires_at as number,
  revokedAt: (r.revoked_at as number | null) ?? null,
  usedAt: (r.used_at as number | null) ?? null,
});
const grant = (r: Row): DeviceGrant => ({
  id: r.id as string,
  deviceCodeHash: r.device_code_hash as string,
  userCode: r.user_code as string,
  status: r.status as DeviceGrant["status"],
  userId: (r.user_id as string | null) ?? null,
  workspaceId: (r.workspace_id as string | null) ?? null,
  clientName: r.client_name as string,
  createdAt: r.created_at as number,
  expiresAt: r.expires_at as number,
  lastPollAt: r.last_poll_at as number,
});
const project = (r: Row): Project => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  name: r.name as string,
  itemId: r.item_id as string,
  visibility: r.visibility as Project["visibility"],
  createdBy: r.created_by as string,
  createdAt: r.created_at as number,
});
const release = (r: Row): Release => ({
  id: r.id as string,
  projectId: r.project_id as string,
  workspaceId: r.workspace_id as string,
  kind: r.kind as Release["kind"],
  version: r.version as string,
  state: r.state as ReleaseState,
  stateDetail: r.state_detail as string,
  sha256: r.sha256 as string,
  sizeBytes: r.size_bytes as number,
  notes: r.notes as string,
  findings: JSON.parse(r.findings_json as string),
  publishType: r.publish_type as Release["publishType"],
  uploadedToStore: r.uploaded_to_store === 1,
  createdBy: r.created_by as string,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
  expiresAt: r.expires_at as number,
  revokedAt: (r.revoked_at as number | null) ?? null,
  revokeReason: r.revoke_reason as string,
  lastSyncAt: (r.last_sync_at as number | null) ?? null,
});
const tester = (r: Row): ReleaseTester => ({
  releaseId: r.release_id as string,
  email: r.email as string,
  addedBy: r.added_by as string,
  addedAt: r.added_at as number,
});
const invite = (r: Row): Invite => ({
  id: r.id as string,
  releaseId: r.release_id as string,
  tokenHash: r.token_hash as string,
  createdBy: r.created_by as string,
  createdAt: r.created_at as number,
  expiresAt: r.expires_at as number,
  revokedAt: (r.revoked_at as number | null) ?? null,
});
const testerSession = (r: Row): TesterSession => ({
  idHash: r.id_hash as string,
  email: r.email as string,
  createdAt: r.created_at as number,
  expiresAt: r.expires_at as number,
});
const audit = (r: Row): AuditEntry => ({
  id: r.id as string,
  workspaceId: (r.workspace_id as string | null) ?? null,
  at: r.at as number,
  actor: r.actor as string,
  action: r.action as string,
  target: r.target as string,
  ip: (r.ip as string | null) ?? null,
  details: JSON.parse(r.details_json as string),
});

export class SqliteStore implements Store {
  constructor(private readonly db: Database) {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
  }

  static open(path: string): SqliteStore {
    const db = new Database(path, { create: true });
    migrate(db);
    return new SqliteStore(db);
  }

  close() {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private one<T>(sql: string, map: (r: Row) => T, ...args: Bindable[]): T | null {
    const r = this.db.query(sql).get(...args) as Row | null;
    return r ? map(r) : null;
  }
  private all<T>(sql: string, map: (r: Row) => T, ...args: Bindable[]): T[] {
    return (this.db.query(sql).all(...args) as Row[]).map(map);
  }
  private run(sql: string, ...args: Bindable[]): number {
    return this.db.query(sql).run(...args).changes;
  }
  private insert(table: string, obj: object) {
    const [cols, vals] = encodePatch(obj);
    this.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...vals);
  }
  private update(table: string, keyCol: string, key: string, patch: object) {
    const [cols, vals] = encodePatch(patch);
    if (cols.length === 0) return;
    this.run(
      `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${keyCol} = ?`,
      ...vals,
      key,
    );
  }

  createUser(u: User) {
    this.insert("users", u);
  }
  getUser(id: string) {
    return this.one("SELECT * FROM users WHERE id = ?", user, id);
  }
  getUserByEmail(email: string) {
    return this.one("SELECT * FROM users WHERE email = ?", user, email);
  }
  updateUser(id: string, patch: Partial<User>) {
    this.update("users", "id", id, patch);
  }

  createWorkspace(w: Workspace) {
    this.insert("workspaces", w);
  }
  getWorkspace(id: string) {
    return this.one("SELECT * FROM workspaces WHERE id = ?", workspace, id);
  }
  addMember(m: Membership) {
    this.insert("memberships", m);
  }
  getMembership(workspaceId: string, userId: string) {
    return this.one(
      "SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?",
      membership,
      workspaceId,
      userId,
    );
  }
  listMemberships(userId: string) {
    return this.all("SELECT * FROM memberships WHERE user_id = ? ORDER BY workspace_id", membership, userId);
  }

  createSession(s: Session) {
    this.insert("sessions", s);
  }
  getSession(idHash: string) {
    return this.one("SELECT * FROM sessions WHERE id_hash = ?", session, idHash);
  }
  updateSession(idHash: string, patch: Partial<Session>) {
    this.update("sessions", "id_hash", idHash, patch);
  }
  deleteSession(idHash: string) {
    this.run("DELETE FROM sessions WHERE id_hash = ?", idHash);
  }
  deleteSessionsForUser(userId: string) {
    this.run("DELETE FROM sessions WHERE user_id = ?", userId);
  }

  createToken(t: ApiToken) {
    this.insert("api_tokens", t);
  }
  getToken(hash: string) {
    return this.one("SELECT * FROM api_tokens WHERE hash = ?", token, hash);
  }
  claimRefreshToken(hash: string, at: number) {
    return (
      this.run(
        "UPDATE api_tokens SET used_at = ? WHERE hash = ? AND kind = 'refresh' AND used_at IS NULL AND revoked_at IS NULL",
        at,
        hash,
      ) === 1
    );
  }
  revokeToken(hash: string, at: number) {
    this.run("UPDATE api_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL", at, hash);
  }
  revokeTokenFamily(family: string, at: number) {
    this.run("UPDATE api_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL", at, family);
  }
  revokeTokensForUser(userId: string, at: number) {
    this.run("UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", at, userId);
  }

  createDeviceGrant(g: DeviceGrant) {
    this.insert("device_grants", g);
  }
  getDeviceGrantByCodeHash(hash: string) {
    return this.one("SELECT * FROM device_grants WHERE device_code_hash = ?", grant, hash);
  }
  getDeviceGrantByUserCode(userCode: string) {
    return this.one("SELECT * FROM device_grants WHERE user_code = ?", grant, userCode);
  }
  updateDeviceGrant(id: string, patch: Partial<DeviceGrant>) {
    this.update("device_grants", "id", id, patch);
  }

  createProject(p: Project) {
    this.insert("projects", p);
  }
  getProject(id: string) {
    return this.one("SELECT * FROM projects WHERE id = ?", project, id);
  }
  getProjectByItemId(itemId: string) {
    return this.one("SELECT * FROM projects WHERE item_id = ?", project, itemId);
  }
  listProjects(workspaceId: string) {
    return this.all(
      "SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at DESC, id DESC",
      project,
      workspaceId,
    );
  }

  createRelease(r: Release) {
    this.insert("releases", r);
  }
  getRelease(id: string) {
    return this.one("SELECT * FROM releases WHERE id = ?", release, id);
  }
  updateRelease(id: string, patch: Partial<Release>) {
    this.update("releases", "id", id, patch);
  }
  listReleases(projectId: string) {
    return this.all(
      "SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC, id DESC",
      release,
      projectId,
    );
  }
  listReleasesInStates(states: readonly ReleaseState[]) {
    if (states.length === 0) return [];
    return this.all(
      `SELECT * FROM releases WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at ASC, id ASC`,
      release,
      ...states,
    );
  }

  addTesters(rows: ReleaseTester[]) {
    const q = this.db.query(
      "INSERT OR IGNORE INTO release_testers (release_id, email, added_by, added_at) VALUES (?, ?, ?, ?)",
    );
    for (const r of rows) q.run(r.releaseId, r.email, r.addedBy, r.addedAt);
  }
  removeTesters(releaseId: string, emails: string[]) {
    const q = this.db.query("DELETE FROM release_testers WHERE release_id = ? AND email = ?");
    for (const e of emails) q.run(releaseId, e);
  }
  listTesters(releaseId: string) {
    return this.all("SELECT * FROM release_testers WHERE release_id = ? ORDER BY email", tester, releaseId);
  }

  createInvite(i: Invite) {
    this.insert("invites", i);
  }
  getInviteByTokenHash(hash: string) {
    return this.one("SELECT * FROM invites WHERE token_hash = ?", invite, hash);
  }
  listInvites(releaseId: string) {
    return this.all(
      "SELECT * FROM invites WHERE release_id = ? ORDER BY created_at DESC, id DESC",
      invite,
      releaseId,
    );
  }
  revokeInvites(releaseId: string, at: number) {
    this.run("UPDATE invites SET revoked_at = ? WHERE release_id = ? AND revoked_at IS NULL", at, releaseId);
  }

  extendInvites(releaseId: string, from: number, to: number) {
    this.run(
      "UPDATE invites SET expires_at = ? WHERE release_id = ? AND revoked_at IS NULL AND expires_at = ?",
      to,
      releaseId,
      from,
    );
  }

  createTesterSession(s: TesterSession) {
    this.insert("tester_sessions", s);
  }
  getTesterSession(idHash: string) {
    return this.one("SELECT * FROM tester_sessions WHERE id_hash = ?", testerSession, idHash);
  }
  deleteTesterSession(idHash: string) {
    this.run("DELETE FROM tester_sessions WHERE id_hash = ?", idHash);
  }

  appendAudit(e: AuditEntry) {
    this.insert("audit_log", e);
  }
  listAudit(q: { workspaceId: string; target?: string; limit: number }) {
    return q.target === undefined
      ? this.all(
          "SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY at DESC, id DESC LIMIT ?",
          audit,
          q.workspaceId,
          q.limit,
        )
      : this.all(
          "SELECT * FROM audit_log WHERE workspace_id = ? AND target = ? ORDER BY at DESC, id DESC LIMIT ?",
          audit,
          q.workspaceId,
          q.target,
          q.limit,
        );
  }

  purgeExpired(now: number) {
    return this.transaction(
      () =>
        this.run("DELETE FROM sessions WHERE expires_at <= ?", now) +
        this.run("DELETE FROM api_tokens WHERE expires_at <= ?", now) +
        this.run("DELETE FROM device_grants WHERE expires_at <= ?", now) +
        this.run("DELETE FROM tester_sessions WHERE expires_at <= ?", now),
    );
  }
}

/** Row mappers keyed by table, exported so the schema test can check them against the migration file. */
export const ROW_MAPPERS = {
  users: user,
  workspaces: workspace,
  memberships: membership,
  sessions: session,
  api_tokens: token,
  device_grants: grant,
  projects: project,
  releases: release,
  release_testers: tester,
  invites: invite,
  tester_sessions: testerSession,
  audit_log: audit,
} as const;
