import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TokenDto } from "@extshare/core";

export interface Credentials extends TokenDto {
  server: string;
  email: string;
}

export interface ProjectConfig {
  server: string;
  projectId: string;
}

/** Everything a command touches outside its own logic, so tests can run commands in-process. */
export interface CliContext {
  cwd: string;
  configDir: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
  openBrowser: (url: string) => void;
  json: boolean;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly detail?: string[],
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function defaultConfigDir(env: Record<string, string | undefined> = process.env): string {
  if (env.EXTSHARE_CONFIG_DIR) return env.EXTSHARE_CONFIG_DIR;
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "extshare");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "extshare");
}

const credPath = (ctx: CliContext) => join(ctx.configDir, "credentials.json");

export function readCredentials(ctx: CliContext): Credentials | null {
  const p = credPath(ctx);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Credentials;
  } catch {
    return null;
  }
}

/** Credentials are written owner-read/write only. On Windows the file inherits the user-profile ACL. */
export function writeCredentials(ctx: CliContext, c: Credentials | null) {
  const p = credPath(ctx);
  if (c === null) {
    if (existsSync(p)) writeFileSync(p, "{}", { mode: 0o600 });
    return;
  }
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {}
}

export const PROJECT_FILE = "extshare.json";

export function readProjectConfig(ctx: CliContext): ProjectConfig | null {
  const p = join(ctx.cwd, PROJECT_FILE);
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, "utf8")) as Partial<ProjectConfig>;
  if (!j.projectId || !j.server)
    throw new CliError(`${PROJECT_FILE} is missing "server" or "projectId"; run extshare init`);
  return j as ProjectConfig;
}

export function writeProjectConfig(ctx: CliContext, c: ProjectConfig) {
  writeFileSync(join(ctx.cwd, PROJECT_FILE), `${JSON.stringify(c, null, 2)}\n`);
}

export function normalizeServer(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CliError(`Invalid server URL: ${url}`);
  }
  if (u.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) {
    throw new CliError("The server URL must use https:// (http is allowed only for localhost)");
  }
  return u.origin;
}
