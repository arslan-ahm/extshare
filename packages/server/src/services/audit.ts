import type { Deps } from "../context";
import { newId } from "../security";

export interface AuditInput {
  workspaceId: string | null;
  actor: string;
  action: string;
  target: string;
  ip?: string | null;
  details?: Record<string, unknown>;
}

export function audit(deps: Pick<Deps, "store" | "now">, e: AuditInput) {
  deps.store.appendAudit({
    id: newId("aud"),
    workspaceId: e.workspaceId,
    at: deps.now(),
    actor: e.actor,
    action: e.action,
    target: e.target,
    ip: e.ip ?? null,
    details: e.details ?? {},
  });
}
