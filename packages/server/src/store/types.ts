import type { Finding, ReleaseState, Visibility } from "@extshare/core";

export type Role = "owner" | "publisher" | "viewer";

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  totpSecret: string | null;
  totpEnabled: boolean;
  /** Last accepted TOTP time-step, so a code cannot be replayed. */
  totpLastStep: number;
  disabled: boolean;
  createdAt: number;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
}

export interface Membership {
  workspaceId: string;
  userId: string;
  role: Role;
}

export interface Session {
  idHash: string;
  userId: string;
  workspaceId: string;
  mfaPassed: boolean;
  csrf: string;
  createdAt: number;
  expiresAt: number;
}

export interface ApiToken {
  hash: string;
  kind: "access" | "refresh";
  userId: string;
  workspaceId: string;
  /** All tokens issued from one device login share a family; reuse of a rotated refresh token revokes the family. */
  family: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  /** Set on a refresh token once it has been exchanged. */
  usedAt: number | null;
}

export interface DeviceGrant {
  id: string;
  deviceCodeHash: string;
  userCode: string;
  status: "pending" | "approved" | "denied" | "consumed";
  userId: string | null;
  workspaceId: string | null;
  clientName: string;
  createdAt: number;
  expiresAt: number;
  lastPollAt: number;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  itemId: string;
  visibility: Visibility;
  createdBy: string;
  createdAt: number;
}

export interface Release {
  id: string;
  projectId: string;
  workspaceId: string;
  kind: "build" | "withdrawal";
  version: string;
  state: ReleaseState;
  stateDetail: string;
  sha256: string;
  sizeBytes: number;
  notes: string;
  findings: Finding[];
  publishType: "DEFAULT_PUBLISH" | "STAGED_PUBLISH";
  /** True once the Web Store accepted the package; the store then requires later versions to be higher. */
  uploadedToStore: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokeReason: string;
  lastSyncAt: number | null;
}

export interface ReleaseTester {
  releaseId: string;
  email: string;
  addedBy: string;
  addedAt: number;
}

export interface Invite {
  id: string;
  releaseId: string;
  tokenHash: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export interface TesterSession {
  idHash: string;
  email: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuditEntry {
  id: string;
  workspaceId: string | null;
  at: number;
  actor: string;
  action: string;
  target: string;
  ip: string | null;
  details: Record<string, unknown>;
}

/**
 * Persistence boundary. Every implementation must pass the shared contract suite in
 * test/store-contract.ts. Reads return copies: mutating a returned object never changes stored state.
 */
export interface Store {
  transaction<T>(fn: () => T): T;

  createUser(u: User): void;
  getUser(id: string): User | null;
  getUserByEmail(email: string): User | null;
  updateUser(id: string, patch: Partial<Omit<User, "id" | "email" | "createdAt">>): void;

  createWorkspace(w: Workspace): void;
  getWorkspace(id: string): Workspace | null;
  addMember(m: Membership): void;
  getMembership(workspaceId: string, userId: string): Membership | null;
  listMemberships(userId: string): Membership[];

  createSession(s: Session): void;
  getSession(idHash: string): Session | null;
  updateSession(
    idHash: string,
    patch: Partial<Pick<Session, "mfaPassed" | "workspaceId" | "expiresAt">>,
  ): void;
  deleteSession(idHash: string): void;
  deleteSessionsForUser(userId: string): void;

  createToken(t: ApiToken): void;
  getToken(hash: string): ApiToken | null;
  /** Atomically marks a refresh token used; returns false if it was already used or revoked. */
  claimRefreshToken(hash: string, at: number): boolean;
  revokeToken(hash: string, at: number): void;
  revokeTokenFamily(family: string, at: number): void;
  revokeTokensForUser(userId: string, at: number): void;

  createDeviceGrant(g: DeviceGrant): void;
  getDeviceGrantByCodeHash(hash: string): DeviceGrant | null;
  getDeviceGrantByUserCode(userCode: string): DeviceGrant | null;
  updateDeviceGrant(
    id: string,
    patch: Partial<Pick<DeviceGrant, "status" | "userId" | "workspaceId" | "lastPollAt">>,
  ): void;

  createProject(p: Project): void;
  getProject(id: string): Project | null;
  getProjectByItemId(itemId: string): Project | null;
  listProjects(workspaceId: string): Project[];

  createRelease(r: Release): void;
  getRelease(id: string): Release | null;
  updateRelease(
    id: string,
    patch: Partial<Omit<Release, "id" | "projectId" | "workspaceId" | "createdAt">>,
  ): void;
  /** Newest first. */
  listReleases(projectId: string): Release[];
  listReleasesInStates(states: readonly ReleaseState[]): Release[];

  addTesters(rows: ReleaseTester[]): void;
  removeTesters(releaseId: string, emails: string[]): void;
  listTesters(releaseId: string): ReleaseTester[];

  createInvite(i: Invite): void;
  getInviteByTokenHash(hash: string): Invite | null;
  listInvites(releaseId: string): Invite[];
  revokeInvites(releaseId: string, at: number): void;
  /** Moves unrevoked invites that expired together with the release (expiresAt === from) to the new expiry. */
  extendInvites(releaseId: string, from: number, to: number): void;

  createTesterSession(s: TesterSession): void;
  getTesterSession(idHash: string): TesterSession | null;
  deleteTesterSession(idHash: string): void;

  appendAudit(e: AuditEntry): void;
  /** Newest first. */
  listAudit(q: { workspaceId: string; target?: string; limit: number }): AuditEntry[];

  /** Removes expired sessions, tokens, grants and tester sessions. Returns rows removed. */
  purgeExpired(now: number): number;
}
