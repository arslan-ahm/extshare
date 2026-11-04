import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ServiceAccountKey } from "./cws";

const EnvSchema = z
  .object({
    PUBLIC_URL: z
      .string()
      .url()
      .transform((s) => s.replace(/\/+$/, "")),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    HOST: z.string().default("127.0.0.1"),
    DATA_DIR: z.string().default("./data"),
    SECRET: z
      .string()
      .min(32, "SECRET must be at least 32 characters; generate one with: openssl rand -base64 48"),
    TRUST_PROXY: z.enum(["true", "false"]).default("false"),
    SYNC_INTERVAL_SEC: z.coerce.number().int().min(30).default(120),
    CWS_PUBLISHER_ID: z
      .string()
      .min(1, "CWS_PUBLISHER_ID is required (Developer Dashboard > Publisher > Settings)"),
    CWS_CLIENT_ID: z.string().optional(),
    CWS_CLIENT_SECRET: z.string().optional(),
    CWS_REFRESH_TOKEN: z.string().optional(),
    CWS_SERVICE_ACCOUNT_FILE: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    const refresh = e.CWS_CLIENT_ID && e.CWS_CLIENT_SECRET && e.CWS_REFRESH_TOKEN;
    if (!refresh && !e.CWS_SERVICE_ACCOUNT_FILE) {
      ctx.addIssue({
        code: "custom",
        message:
          "Set CWS_SERVICE_ACCOUNT_FILE, or all of CWS_CLIENT_ID, CWS_CLIENT_SECRET and CWS_REFRESH_TOKEN",
      });
    }
    if (Boolean(e.GOOGLE_CLIENT_ID) !== Boolean(e.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: "custom",
        message: "Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for tester sign-in, or neither",
      });
    }
    if (
      !e.PUBLIC_URL.startsWith("https://") &&
      !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(e.PUBLIC_URL)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "PUBLIC_URL must be https:// (plain http is only allowed for localhost)",
      });
    }
  });

export type ServerEnv = z.output<typeof EnvSchema>;

export type CwsCredentials =
  | { kind: "refresh_token"; clientId: string; clientSecret: string; refreshToken: string }
  | { kind: "service_account"; key: ServiceAccountKey };

export function loadEnv(env: Record<string, string | undefined>): ServerEnv {
  const r = EnvSchema.safeParse(env);
  if (!r.success) {
    throw new Error(
      `Invalid configuration:\n${r.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`).join("\n")}`,
    );
  }
  return r.data;
}

export function cwsCredentials(e: ServerEnv): CwsCredentials {
  if (e.CWS_SERVICE_ACCOUNT_FILE) {
    const key = JSON.parse(readFileSync(e.CWS_SERVICE_ACCOUNT_FILE, "utf8")) as ServiceAccountKey;
    return { kind: "service_account", key };
  }
  return {
    kind: "refresh_token",
    clientId: e.CWS_CLIENT_ID!,
    clientSecret: e.CWS_CLIENT_SECRET!,
    refreshToken: e.CWS_REFRESH_TOKEN!,
  };
}
