import { z } from "zod";
import type { ReleaseState, Visibility } from "./lifecycle";
import type { Finding } from "./manifest";

/** Wire contract shared by the CLI and the server. The server validates every body with these schemas. */

const email = z.string().trim().toLowerCase().email().max(254);

export const PublishMetaSchema = z.object({
  ttl: z.string().min(2).max(16),
  testers: z.array(email).max(500).default([]),
  inheritTesters: z.boolean().default(true),
  notes: z.string().max(2000).default(""),
  publishType: z.enum(["DEFAULT_PUBLISH", "STAGED_PUBLISH"]).default("DEFAULT_PUBLISH"),
  strictSourceMaps: z.boolean().default(false),
});
export type PublishMeta = z.input<typeof PublishMetaSchema>;

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  itemId: z.string().regex(/^[a-p]{32}$/, "must be a 32-character Chrome extension ID (letters a-p)"),
  visibility: z.enum(["private", "unlisted"]),
});
export type CreateProject = z.input<typeof CreateProjectSchema>;

export const TestersChangeSchema = z.object({
  add: z.array(email).max(500).default([]),
  remove: z.array(email).max(500).default([]),
});
export type TestersChange = z.input<typeof TestersChangeSchema>;

export const RevokeSchema = z.object({
  reason: z.string().max(500).default(""),
  cancelSubmission: z.boolean().default(true),
  killSwitch: z.boolean().default(false),
});
export type RevokeRequest = z.input<typeof RevokeSchema>;

export const ExtendSchema = z.object({ ttl: z.string().min(2).max(16) });
export const InviteCreateSchema = z.object({ ttl: z.string().min(2).max(16).optional() });
export const DeviceTokenSchema = z.object({ deviceCode: z.string().min(16).max(128) });
export const RefreshSchema = z.object({ refreshToken: z.string().min(16).max(256) });

export interface ApiErrorBody {
  error: { code: string; message: string; findings?: Finding[] };
}

export interface ProjectDto {
  id: string;
  name: string;
  itemId: string;
  visibility: Visibility;
  webStoreUrl: string;
  createdAt: number;
}

export interface ReleaseDto {
  id: string;
  projectId: string;
  kind: "build" | "withdrawal";
  version: string;
  state: ReleaseState;
  stateDetail: string;
  sha256: string;
  sizeBytes: number;
  notes: string;
  findings: Finding[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  testers: string[];
}

export interface PublishResultDto {
  release: ReleaseDto;
  invite: InviteDto | null;
}

export interface InviteDto {
  id: string;
  url: string;
  expiresAt: number;
}

export interface AuditDto {
  id: string;
  at: number;
  actor: string;
  action: string;
  target: string;
  ip: string | null;
  details: Record<string, unknown>;
}

export interface DeviceStartDto {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSec: number;
  expiresInSec: number;
}

export interface TokenDto {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type DeviceTokenResponse = TokenDto | { pending: true; slowDown?: boolean };

export interface MeDto {
  email: string;
  name: string;
  workspace: { id: string; name: string; role: "owner" | "publisher" | "viewer" };
}
