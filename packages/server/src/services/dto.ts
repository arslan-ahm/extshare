import { type AuditDto, type ProjectDto, type ReleaseDto, webStoreUrl } from "@extshare/core";
import type { AuditEntry, Project, Release, Store } from "../store/types";

export function projectDto(p: Project): ProjectDto {
  return {
    id: p.id,
    name: p.name,
    itemId: p.itemId,
    visibility: p.visibility,
    webStoreUrl: webStoreUrl(p.itemId),
    createdAt: p.createdAt,
  };
}

export function releaseDto(r: Release, store: Store): ReleaseDto {
  return {
    id: r.id,
    projectId: r.projectId,
    kind: r.kind,
    version: r.version,
    state: r.state,
    stateDetail: r.stateDetail,
    sha256: r.sha256,
    sizeBytes: r.sizeBytes,
    notes: r.notes,
    findings: r.findings,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    testers: store.listTesters(r.id).map((t) => t.email),
  };
}

export function auditDto(e: AuditEntry): AuditDto {
  return {
    id: e.id,
    at: e.at,
    actor: e.actor,
    action: e.action,
    target: e.target,
    ip: e.ip,
    details: e.details,
  };
}
