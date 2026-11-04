import {
  type AccessDecision,
  buildWithdrawnPackage,
  CreateProjectSchema,
  compareVersions,
  decideAccess,
  ExtendSchema,
  InviteCreateSchema,
  type InviteDto,
  inspectPackage,
  mapCwsStatus,
  nextStateAfterSync,
  normalizeEmail,
  PublishMetaSchema,
  parseTtl,
  RELEASE_STATES,
  type ReleaseState,
  RevokeSchema,
  SYNCABLE,
  TestersChangeSchema,
} from "@extshare/core";
import type { z } from "zod";
import { type Actor, AppError, type Deps, requireRole } from "../context";
import { CwsApiError, type CwsPublishResult } from "../cws";
import { hashToken, newId, randomToken } from "../security";
import type { Invite, Project, Release } from "../store/types";
import { audit } from "./audit";

/** A publish stuck in "uploading" longer than this no longer blocks new publishes (the process likely died). */
export const STALE_UPLOAD_MS = 10 * 60_000;
export const WITHDRAWAL_TTL_MS = 90 * 86_400_000;

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new AppError(400, "invalid_request", msg);
  }
  return r.data;
}

function ttlOrThrow(ttl: string): number {
  try {
    return parseTtl(ttl);
  } catch (e) {
    throw new AppError(400, "invalid_ttl", (e as Error).message);
  }
}

function itemStateToRelease(state: CwsPublishResult["state"]): ReleaseState {
  switch (state) {
    case "PUBLISHED":
    case "PUBLISHED_TO_TESTERS":
      return "live";
    case "STAGED":
      return "staged";
    case "REJECTED":
      return "rejected";
    case "CANCELLED":
      return "cancelled";
    default:
      return "in_review";
  }
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ReleaseService {
  constructor(private readonly deps: Deps) {}

  // ---- scoping ----

  /** Loads a project in the actor's workspace; another workspace's project is reported as not found. */
  getProject(actor: Actor, projectId: string): Project {
    const p = this.deps.store.getProject(projectId);
    if (!p || p.workspaceId !== actor.workspaceId) throw new AppError(404, "not_found", "Project not found");
    return p;
  }

  getRelease(actor: Actor, releaseId: string): { release: Release; project: Project } {
    const r = this.deps.store.getRelease(releaseId);
    if (!r || r.workspaceId !== actor.workspaceId) throw new AppError(404, "not_found", "Release not found");
    const project = this.deps.store.getProject(r.projectId);
    if (!project) throw new AppError(404, "not_found", "Release not found");
    return { release: r, project };
  }

  // ---- projects ----

  createProject(actor: Actor, body: unknown): Project {
    requireRole(actor, "publisher");
    const input = parseBody(CreateProjectSchema, body);
    const { store, now } = this.deps;
    if (store.getProjectByItemId(input.itemId)) {
      throw new AppError(409, "item_taken", "That Chrome Web Store item is already linked to a project");
    }
    const project: Project = {
      id: newId("prj"),
      workspaceId: actor.workspaceId,
      name: input.name,
      itemId: input.itemId,
      visibility: input.visibility,
      createdBy: actor.email,
      createdAt: now(),
    };
    store.createProject(project);
    audit(this.deps, {
      workspaceId: actor.workspaceId,
      actor: actor.email,
      action: "project.created",
      target: project.id,
      ip: actor.ip,
      details: { itemId: project.itemId, visibility: project.visibility },
    });
    return project;
  }

  // ---- publish ----

  async publish(
    actor: Actor,
    projectId: string,
    bytes: Uint8Array,
    rawMeta: unknown,
  ): Promise<{ release: Release; invite: InviteDto | null }> {
    requireRole(actor, "publisher");
    const { store, artifacts, now } = this.deps;
    const project = this.getProject(actor, projectId);
    const meta = parseBody(PublishMetaSchema, rawMeta);
    const ttlMs = ttlOrThrow(meta.ttl);

    const report = inspectPackage(bytes, { strictSourceMaps: meta.strictSourceMaps });
    if (!report.ok || !report.manifest) {
      audit(this.deps, {
        workspaceId: actor.workspaceId,
        actor: actor.email,
        action: "release.blocked",
        target: project.id,
        ip: actor.ip,
        details: {
          sha256: report.sha256,
          errors: report.findings.filter((f) => f.severity === "error").map((f) => f.code),
        },
      });
      throw new AppError(422, "package_invalid", "The package failed validation", report.findings);
    }
    const version = report.manifest.version;

    const existing = this.assertPublishable(project.id, version);

    const testers = new Set(meta.testers.map(normalizeEmail));
    if (meta.inheritTesters) {
      const prev = existing.find((r) => r.kind === "build");
      if (prev) for (const t of store.listTesters(prev.id)) testers.add(t.email);
    }
    if (project.visibility === "private" && testers.size === 0) {
      throw new AppError(
        400,
        "testers_required",
        "Private projects need at least one tester (--testers a@x.com,b@y.com)",
      );
    }

    await artifacts.put(report.sha256, bytes);

    const t = now();
    const release: Release = {
      id: newId("rel"),
      projectId: project.id,
      workspaceId: project.workspaceId,
      kind: "build",
      version,
      state: "uploading",
      stateDetail: "Uploading to the Chrome Web Store",
      sha256: report.sha256,
      sizeBytes: report.sizeBytes,
      notes: meta.notes,
      findings: report.findings,
      publishType: meta.publishType,
      uploadedToStore: false,
      createdBy: actor.email,
      createdAt: t,
      updatedAt: t,
      expiresAt: t + ttlMs,
      revokedAt: null,
      revokeReason: "",
      lastSyncAt: null,
    };
    let invite: InviteDto | null = null;
    store.transaction(() => {
      // Re-checked here because another publish may have started during the artifact write above;
      // this check and the insert run without yielding, so two publishes cannot both pass.
      this.assertPublishable(project.id, version);
      store.createRelease(release);
      store.addTesters(
        [...testers].map((email) => ({ releaseId: release.id, email, addedBy: actor.email, addedAt: t })),
      );
      invite = this.insertInvite(actor, release, release.expiresAt);
      audit(this.deps, {
        workspaceId: actor.workspaceId,
        actor: actor.email,
        action: "release.created",
        target: release.id,
        ip: actor.ip,
        details: {
          projectId: project.id,
          version,
          sha256: report.sha256,
          ttlMs,
          testers: [...testers],
          warnings: report.findings.length,
        },
      });
    });

    await this.pushToStore(release, project, bytes);
    return { release: store.getRelease(release.id)!, invite };
  }

  /** Refuses a publish while another is uploading, or when the version is not above the item's last uploaded one. */
  private assertPublishable(projectId: string, version: string): Release[] {
    const { store, now } = this.deps;
    const existing = store.listReleases(projectId);
    const busy = existing.find((r) => r.state === "uploading" && now() - r.updatedAt < STALE_UPLOAD_MS);
    if (busy) {
      throw new AppError(
        409,
        "publish_in_progress",
        `Release ${busy.id} is still uploading to the Web Store`,
      );
    }
    const highest = existing
      .filter((r) => r.uploadedToStore)
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (highest && compareVersions(version, highest.version) <= 0) {
      throw new AppError(
        409,
        "version_not_bumped",
        `manifest version ${version} must be higher than ${highest.version}, the last version uploaded to this Web Store item`,
      );
    }
    return existing;
  }

  /** Uploads and submits a stored release. Every failure is recorded on the release rather than thrown. */
  private async pushToStore(release: Release, project: Project, bytes: Uint8Array) {
    const { cws, config, sleep } = this.deps;
    let uploadState: string;
    try {
      const up = await cws.upload(project.itemId, bytes);
      uploadState = up.uploadState;
      if (up.uploadState === "SUCCEEDED" && up.crxVersion && up.crxVersion !== release.version) {
        return this.setState(
          release,
          "failed",
          `Web Store reports version ${up.crxVersion}, expected ${release.version}`,
        );
      }
    } catch (e) {
      return this.setState(release, "failed", `Upload failed: ${errMessage(e)}`);
    }

    if (uploadState === "IN_PROGRESS" || uploadState === "UPLOAD_IN_PROGRESS") {
      this.setState(release, "processing", "Web Store is processing the upload", { uploadedToStore: true });
      for (let i = 0; i < config.uploadPollAttempts; i++) {
        await sleep(config.uploadPollIntervalMs);
        try {
          const st = await cws.fetchStatus(project.itemId);
          uploadState = st.lastAsyncUploadState ?? "IN_PROGRESS";
        } catch (e) {
          this.deps.log("warn", "fetchStatus during upload polling failed", {
            release: release.id,
            error: errMessage(e),
          });
          continue;
        }
        if (uploadState !== "IN_PROGRESS" && uploadState !== "UPLOAD_IN_PROGRESS") break;
      }
      // Still processing: the sync loop submits it once the Web Store finishes.
      if (uploadState === "IN_PROGRESS" || uploadState === "UPLOAD_IN_PROGRESS") return;
    }
    if (uploadState !== "SUCCEEDED")
      return this.setState(release, "failed", `Web Store upload state: ${uploadState}`);
    this.deps.store.updateRelease(release.id, { uploadedToStore: true });
    await this.submit(release, project);
  }

  private async submit(release: Release, project: Project) {
    try {
      const res = await this.deps.cws.publish(project.itemId, { publishType: release.publishType });
      const warn = res.warnings.map((w) => `${w.reason}: ${w.description}`).join("; ");
      const state = itemStateToRelease(res.state);
      this.setState(release, state, `Submitted (${res.state})${warn ? ` — warnings: ${warn}` : ""}`, {
        uploadedToStore: true,
      });
      if (state === "live") this.supersedeOlder(project.id, release);
    } catch (e) {
      this.setState(release, "failed", `Submit failed: ${errMessage(e)}`, { uploadedToStore: true });
    }
  }

  private setState(release: Release, state: ReleaseState, detail: string, extra: Partial<Release> = {}) {
    const { store, now } = this.deps;
    const before = store.getRelease(release.id);
    store.updateRelease(release.id, { state, stateDetail: detail, updatedAt: now(), ...extra });
    if (before?.state !== state) {
      audit(this.deps, {
        workspaceId: release.workspaceId,
        actor: "system",
        action: "release.state_changed",
        target: release.id,
        details: { from: before?.state, to: state, detail },
      });
    }
  }

  private supersedeOlder(projectId: string, live: Release) {
    for (const r of this.deps.store.listReleases(projectId)) {
      if (r.id !== live.id && r.state === "live" && compareVersions(r.version, live.version) < 0) {
        this.setState(r, "superseded", `Version ${live.version} replaced this build on the Web Store`);
      }
    }
  }

  // ---- status sync ----

  async sync(actor: Actor, releaseId: string): Promise<Release> {
    const { release } = this.getRelease(actor, releaseId);
    await this.syncProject(release.projectId);
    return this.deps.store.getRelease(release.id)!;
  }

  /** Polls the Web Store once per project with releases awaiting an outcome. Returns how many releases changed state. */
  async syncAll(): Promise<number> {
    const pending = this.deps.store.listReleasesInStates([...SYNCABLE]);
    let changed = 0;
    for (const projectId of new Set(pending.map((r) => r.projectId))) {
      try {
        changed += await this.syncProject(projectId);
      } catch (e) {
        this.deps.log("warn", "status sync failed", { projectId, error: errMessage(e) });
      }
    }
    return changed;
  }

  private async syncProject(projectId: string): Promise<number> {
    const { store, cws, now } = this.deps;
    const project = store.getProject(projectId);
    if (!project) return 0;
    const releases = store.listReleases(projectId);
    const candidates = releases.filter((r) => SYNCABLE.has(r.state) && r.uploadedToStore);
    if (candidates.length === 0) return 0;
    const latest = releases
      .filter((r) => r.uploadedToStore)
      .sort((a, b) => compareVersions(b.version, a.version))[0];

    let status: Awaited<ReturnType<typeof cws.fetchStatus>>;
    try {
      status = await cws.fetchStatus(project.itemId);
    } catch (e) {
      if (e instanceof CwsApiError) {
        for (const r of candidates)
          store.updateRelease(r.id, { lastSyncAt: now(), stateDetail: `Status check failed: ${e.message}` });
        return 0;
      }
      throw e;
    }

    let changed = 0;
    for (const r of candidates) {
      const fresh = store.getRelease(r.id)!;
      if (fresh.state === "processing" && fresh.id === latest?.id) {
        const up = status.lastAsyncUploadState;
        if (up === "SUCCEEDED") {
          await this.submit(fresh, project);
          changed++;
        } else if (up === "FAILED") {
          this.setState(fresh, "failed", "Web Store reported the upload failed");
          changed++;
        }
        store.updateRelease(r.id, { lastSyncAt: now() });
        continue;
      }
      const mapped = mapCwsStatus(status, fresh.version, fresh.id === latest?.id);
      const next = nextStateAfterSync(fresh.state, mapped);
      store.updateRelease(r.id, { lastSyncAt: now() });
      if (next !== fresh.state) {
        this.setState(fresh, next, mapped?.detail ?? fresh.stateDetail);
        if (next === "live") this.supersedeOlder(project.id, fresh);
        changed++;
      }
    }
    return changed;
  }

  // ---- lifecycle ----

  sweepExpired(): number {
    const { store, now } = this.deps;
    const active = store.listReleasesInStates(
      RELEASE_STATES.filter((s) => s !== "expired" && s !== "revoked"),
    );
    let n = 0;
    for (const r of active) {
      if (r.expiresAt > now() || r.kind === "withdrawal") continue;
      store.transaction(() => {
        store.updateRelease(r.id, { state: "expired", stateDetail: "Test window ended", updatedAt: now() });
        store.revokeInvites(r.id, now());
        audit(this.deps, {
          workspaceId: r.workspaceId,
          actor: "system",
          action: "release.expired",
          target: r.id,
          details: { from: r.state },
        });
      });
      n++;
    }
    return n;
  }

  async revoke(
    actor: Actor,
    releaseId: string,
    body: unknown,
  ): Promise<{ release: Release; withdrawal: Release | null }> {
    requireRole(actor, "publisher");
    const opts = parseBody(RevokeSchema, body);
    const { store, now, cws } = this.deps;
    const { release, project } = this.getRelease(actor, releaseId);
    if (release.state === "revoked") throw new AppError(409, "already_revoked", "Release is already revoked");
    if (release.kind === "withdrawal")
      throw new AppError(400, "invalid_target", "A withdrawal build cannot be revoked");

    const latest = store
      .listReleases(project.id)
      .filter((r) => r.uploadedToStore)
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    // The withdrawal build replaces whatever the item currently serves to everyone. Aimed at an older
    // release it would wipe out the newer build, so it is refused before anything changes.
    if (opts.killSwitch && latest && latest.id !== release.id) {
      throw new AppError(
        409,
        "not_latest",
        `The kill switch replaces the newest build on this item (${latest.version}), not ${release.version}. Revoke ${release.version} without it, or revoke ${latest.version} with it.`,
      );
    }

    const wasState = release.state;
    store.transaction(() => {
      store.updateRelease(release.id, {
        state: "revoked",
        stateDetail: opts.reason ? `Revoked: ${opts.reason}` : "Revoked",
        revokedAt: now(),
        revokeReason: opts.reason,
        updatedAt: now(),
      });
      store.revokeInvites(release.id, now());
      audit(this.deps, {
        workspaceId: actor.workspaceId,
        actor: actor.email,
        action: "release.revoked",
        target: release.id,
        ip: actor.ip,
        details: {
          reason: opts.reason,
          from: wasState,
          cancelSubmission: opts.cancelSubmission,
          killSwitch: opts.killSwitch,
        },
      });
    });

    if (
      opts.cancelSubmission &&
      ["processing", "in_review", "staged"].includes(wasState) &&
      latest?.id === release.id
    ) {
      try {
        await cws.cancelSubmission(project.itemId);
        audit(this.deps, {
          workspaceId: actor.workspaceId,
          actor: actor.email,
          action: "store.submission_cancelled",
          target: release.id,
          ip: actor.ip,
        });
      } catch (e) {
        store.updateRelease(release.id, {
          stateDetail: `Revoked; cancelling the Web Store submission failed: ${errMessage(e)}`,
        });
      }
    }

    let withdrawal: Release | null = null;
    if (opts.killSwitch)
      withdrawal = await this.publishWithdrawal(actor, project, release, latest ?? release);
    return { release: store.getRelease(release.id)!, withdrawal };
  }

  /**
   * Publishes an inert successor version so Chrome auto-updates installed copies to it. It goes
   * through Web Store review like any update and replaces the build for every user of the item.
   */
  private async publishWithdrawal(
    actor: Actor,
    project: Project,
    revoked: Release,
    latest: Release,
  ): Promise<Release> {
    const { store, artifacts, now } = this.deps;
    const bytes = await artifacts.get(revoked.sha256);
    let name = project.name;
    if (bytes) {
      const m = inspectPackage(bytes).manifest;
      if (m && !/^__MSG_/.test(m.name)) name = m.name;
    }
    const { zip, version } = buildWithdrawnPackage({ name, currentVersion: latest.version });
    const report = inspectPackage(zip);
    if (!report.ok)
      throw new AppError(
        500,
        "withdrawal_invalid",
        "Generated withdrawal package failed validation",
        report.findings,
      );
    await artifacts.put(report.sha256, zip);
    const t = now();
    const w: Release = {
      id: newId("rel"),
      projectId: project.id,
      workspaceId: project.workspaceId,
      kind: "withdrawal",
      version,
      state: "uploading",
      stateDetail: `Withdrawal build replacing ${revoked.version}`,
      sha256: report.sha256,
      sizeBytes: report.sizeBytes,
      notes: `Kill switch for ${revoked.id}`,
      findings: report.findings,
      publishType: "DEFAULT_PUBLISH",
      uploadedToStore: false,
      createdBy: actor.email,
      createdAt: t,
      updatedAt: t,
      expiresAt: t + WITHDRAWAL_TTL_MS,
      revokedAt: null,
      revokeReason: "",
      lastSyncAt: null,
    };
    store.createRelease(w);
    audit(this.deps, {
      workspaceId: actor.workspaceId,
      actor: actor.email,
      action: "release.kill_switch",
      target: revoked.id,
      ip: actor.ip,
      details: { withdrawalId: w.id, version },
    });
    await this.pushToStore(w, project, zip);
    return store.getRelease(w.id)!;
  }

  extend(actor: Actor, releaseId: string, body: unknown): Release {
    requireRole(actor, "publisher");
    const { ttl } = parseBody(ExtendSchema, body);
    const ms = ttlOrThrow(ttl);
    const { store, now } = this.deps;
    const { release } = this.getRelease(actor, releaseId);
    if (release.state === "revoked" || release.state === "expired") {
      throw new AppError(
        409,
        "release_closed",
        `A ${release.state} release cannot be extended; publish a new build`,
      );
    }
    const expiresAt = now() + ms;
    store.transaction(() => {
      store.updateRelease(release.id, { expiresAt, updatedAt: now() });
      store.extendInvites(release.id, release.expiresAt, expiresAt);
      audit(this.deps, {
        workspaceId: actor.workspaceId,
        actor: actor.email,
        action: "release.extended",
        target: release.id,
        ip: actor.ip,
        details: { from: release.expiresAt, to: expiresAt },
      });
    });
    return store.getRelease(release.id)!;
  }

  changeTesters(actor: Actor, releaseId: string, body: unknown): string[] {
    requireRole(actor, "publisher");
    const change = parseBody(TestersChangeSchema, body);
    const { store, now } = this.deps;
    const { release } = this.getRelease(actor, releaseId);
    store.transaction(() => {
      if (change.add.length) {
        store.addTesters(
          change.add.map((email) => ({ releaseId: release.id, email, addedBy: actor.email, addedAt: now() })),
        );
      }
      if (change.remove.length) store.removeTesters(release.id, change.remove);
      audit(this.deps, {
        workspaceId: actor.workspaceId,
        actor: actor.email,
        action: "testers.changed",
        target: release.id,
        ip: actor.ip,
        details: { added: change.add, removed: change.remove },
      });
    });
    return store.listTesters(release.id).map((t) => t.email);
  }

  /** Revokes every existing link for the release and returns a fresh one. The raw token is only ever returned here. */
  rotateInvite(actor: Actor, releaseId: string, body: unknown): InviteDto {
    requireRole(actor, "publisher");
    const { ttl } = parseBody(InviteCreateSchema, body ?? {});
    const { store, now } = this.deps;
    const { release } = this.getRelease(actor, releaseId);
    if (release.state === "revoked" || release.state === "expired" || release.expiresAt <= now()) {
      throw new AppError(
        409,
        "release_closed",
        "This release is closed; publish a new build to share it again",
      );
    }
    if (release.kind === "withdrawal")
      throw new AppError(400, "invalid_target", "Withdrawal builds are not shared");
    const expiresAt = ttl ? Math.min(release.expiresAt, now() + ttlOrThrow(ttl)) : release.expiresAt;
    return store.transaction(() => {
      store.revokeInvites(release.id, now());
      return this.insertInvite(actor, release, expiresAt);
    });
  }

  private insertInvite(actor: Actor, release: Release, expiresAt: number): InviteDto {
    const token = randomToken(32);
    const invite: Invite = {
      id: newId("inv"),
      releaseId: release.id,
      tokenHash: hashToken(token),
      createdBy: actor.email,
      createdAt: this.deps.now(),
      expiresAt,
      revokedAt: null,
    };
    this.deps.store.createInvite(invite);
    audit(this.deps, {
      workspaceId: release.workspaceId,
      actor: actor.email,
      action: "invite.created",
      target: release.id,
      ip: actor.ip,
      details: { inviteId: invite.id, expiresAt },
    });
    return { id: invite.id, url: `${this.deps.config.publicUrl}/r/${token}`, expiresAt };
  }

  // ---- gateway ----

  /** Evaluates an invite link visit. Every decision on a real invite is written to the audit log. */
  evaluateInvite(
    token: string,
    testerEmail: string | null,
    ip: string | null,
  ): { decision: AccessDecision; release: Release | null; project: Project | null } {
    const { store, now } = this.deps;
    const invite = /^[A-Za-z0-9_-]{20,100}$/.test(token)
      ? store.getInviteByTokenHash(hashToken(token))
      : null;
    const release = invite ? store.getRelease(invite.releaseId) : null;
    const project = release ? store.getProject(release.projectId) : null;
    const testers = new Set(release ? store.listTesters(release.id).map((t) => t.email) : []);
    const decision = decideAccess({
      now: now(),
      release: release && project ? release : null,
      invite,
      visibility: project?.visibility ?? "private",
      testers,
      email: testerEmail,
    });
    if (!release || !project) {
      // Unknown tokens are not tied to any workspace; logging them keeps anonymous traffic out of the audit table.
      this.deps.log("info", "gateway visit with unknown token", { ip });
    } else if (decision.kind !== "signin") {
      audit(this.deps, {
        workspaceId: release.workspaceId,
        actor: testerEmail ?? "anonymous",
        action: `gateway.${decision.kind}`,
        target: release.id,
        ip,
        details: {
          inviteId: invite?.id ?? null,
          ...(decision.kind === "deny" ? { reason: decision.reason } : {}),
        },
      });
    }
    return { decision, release, project };
  }
}
