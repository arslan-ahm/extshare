import { compareVersions, parseVersion } from "./version";

export const RELEASE_STATES = [
  "uploading",
  "processing",
  "in_review",
  "staged",
  "live",
  "rejected",
  "cancelled",
  "failed",
  "superseded",
  "expired",
  "revoked",
] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

/** States the platform itself sets; a Web Store status sync never overrides them. */
export const LOCAL_TERMINAL: ReadonlySet<ReleaseState> = new Set(["expired", "revoked", "failed"]);
export const TERMINAL: ReadonlySet<ReleaseState> = new Set([
  "rejected",
  "cancelled",
  "failed",
  "superseded",
  "expired",
  "revoked",
]);
/** States worth polling the Web Store for. `live` is polled to notice supersession or takedown. */
export const SYNCABLE: ReadonlySet<ReleaseState> = new Set(["processing", "in_review", "staged", "live"]);

export type Visibility = "private" | "unlisted";

// Shapes below follow the Chrome Web Store API v2 reference (publishers.items.fetchStatus / ItemState / UploadState).
export type CwsItemState =
  | "ITEM_STATE_UNSPECIFIED"
  | "PENDING_REVIEW"
  | "STAGED"
  | "PUBLISHED"
  | "PUBLISHED_TO_TESTERS"
  | "REJECTED"
  | "CANCELLED";
/** The docs disagree on IN_PROGRESS vs UPLOAD_IN_PROGRESS, so both are accepted. */
export type CwsUploadState =
  | "UPLOAD_STATE_UNSPECIFIED"
  | "SUCCEEDED"
  | "IN_PROGRESS"
  | "UPLOAD_IN_PROGRESS"
  | "FAILED"
  | "NOT_FOUND";

export interface CwsRevisionStatus {
  state: CwsItemState;
  distributionChannels?: { deployPercentage?: number; crxVersion?: string }[];
}

export interface CwsItemStatus {
  name?: string;
  itemId?: string;
  publicKey?: string;
  publishedItemRevisionStatus?: CwsRevisionStatus;
  submittedItemRevisionStatus?: CwsRevisionStatus;
  lastAsyncUploadState?: CwsUploadState;
  takenDown?: boolean;
  warned?: boolean;
}

export interface StatusMapping {
  state: ReleaseState;
  detail: string;
}

const versionsOf = (r?: CwsRevisionStatus) =>
  (r?.distributionChannels ?? [])
    .map((c) => c.crxVersion)
    .filter((v): v is string => typeof v === "string" && parseVersion(v) !== null);

function fromItemState(s: CwsItemState): ReleaseState | null {
  switch (s) {
    case "PENDING_REVIEW":
      return "in_review";
    case "STAGED":
      return "staged";
    case "PUBLISHED":
    case "PUBLISHED_TO_TESTERS":
      return "live";
    case "REJECTED":
      return "rejected";
    case "CANCELLED":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * Works out what a Web Store status means for one specific release version.
 * `isLatestSubmission` says this release is the newest one sent to the item, which lets a
 * revision with no version information be attributed to it. Returns null when the status
 * says nothing about this version yet.
 */
export function mapCwsStatus(
  status: CwsItemStatus,
  version: string,
  isLatestSubmission: boolean,
): StatusMapping | null {
  if (status.takenDown) return { state: "failed", detail: "Item was taken down by the Chrome Web Store" };

  const sub = status.submittedItemRevisionStatus;
  if (sub) {
    const vs = versionsOf(sub);
    if (vs.includes(version) || (vs.length === 0 && isLatestSubmission)) {
      const st = fromItemState(sub.state);
      if (st) return { state: st, detail: `Web Store submission is ${sub.state}` };
    }
  }

  const pub = status.publishedItemRevisionStatus;
  if (pub) {
    const vs = versionsOf(pub);
    const st = fromItemState(pub.state);
    if (vs.includes(version) && st === "live") return { state: "live", detail: `Published (${pub.state})` };
    const newer = vs.find((v) => compareVersions(v, version) > 0);
    if (newer) return { state: "superseded", detail: `Version ${newer} is now published on this item` };
  }

  if (isLatestSubmission) {
    const up = status.lastAsyncUploadState;
    if (up === "IN_PROGRESS" || up === "UPLOAD_IN_PROGRESS")
      return { state: "processing", detail: "Web Store is still processing the upload" };
    if (up === "FAILED") return { state: "failed", detail: "Web Store reported the upload failed" };
  }
  return null;
}

/** Applies a sync result to a release, never overriding a state the platform set itself. */
export function nextStateAfterSync(current: ReleaseState, mapped: StatusMapping | null): ReleaseState {
  if (!mapped || LOCAL_TERMINAL.has(current)) return current;
  if (current === "superseded") return current;
  return mapped.state;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/** Chrome extension IDs are 32 characters from a-p. */
export function isValidItemId(id: string): boolean {
  return /^[a-p]{32}$/.test(id);
}

export function webStoreUrl(itemId: string): string {
  if (!isValidItemId(itemId)) throw new Error(`Invalid Chrome Web Store item ID: ${itemId}`);
  return `https://chromewebstore.google.com/detail/${itemId}`;
}

export interface AccessInput {
  now: number;
  release: { state: ReleaseState; expiresAt: number; revokedAt: number | null } | null;
  invite: { expiresAt: number; revokedAt: number | null } | null;
  visibility: Visibility;
  testers: ReadonlySet<string>;
  /** Verified email of the visitor, or null when not signed in. */
  email: string | null;
}

export type AccessDecision =
  | {
      kind: "deny";
      reason: "invalid_link" | "link_revoked" | "link_expired" | "release_revoked" | "release_expired";
    }
  | { kind: "signin" }
  | { kind: "forbidden" }
  | { kind: "pending"; state: ReleaseState }
  | { kind: "unavailable"; state: ReleaseState }
  | { kind: "allow" };

/**
 * Decides what a visitor of an invite link sees. Link and release validity are checked
 * before identity so a dead link never prompts a sign-in; release status is revealed only
 * to an authorised tester.
 */
export function decideAccess(i: AccessInput): AccessDecision {
  if (!i.release || !i.invite) return { kind: "deny", reason: "invalid_link" };
  if (i.release.revokedAt !== null || i.release.state === "revoked")
    return { kind: "deny", reason: "release_revoked" };
  if (i.release.state === "expired" || i.now >= i.release.expiresAt)
    return { kind: "deny", reason: "release_expired" };
  if (i.invite.revokedAt !== null) return { kind: "deny", reason: "link_revoked" };
  if (i.now >= i.invite.expiresAt) return { kind: "deny", reason: "link_expired" };

  if (!i.email) return { kind: "signin" };
  const email = normalizeEmail(i.email);
  const listed = i.testers.has(email);
  if (i.visibility === "private" && !listed) return { kind: "forbidden" };
  if (i.visibility === "unlisted" && i.testers.size > 0 && !listed) return { kind: "forbidden" };

  if (i.release.state === "live") return { kind: "allow" };
  if (
    i.release.state === "uploading" ||
    i.release.state === "processing" ||
    i.release.state === "in_review" ||
    i.release.state === "staged"
  ) {
    return { kind: "pending", state: i.release.state };
  }
  return { kind: "unavailable", state: i.release.state };
}
