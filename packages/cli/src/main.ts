#!/usr/bin/env bun
import { ApiError } from "./client";
import * as cmd from "./commands";
import { type CliContext, CliError, defaultConfigDir } from "./context";

export const HELP = `extshare: publish Chrome extension test builds and share them with testers

Usage: extshare <command> [options]   (add --json to any command for machine output)

  login --server <url>           Sign in through the browser (device code)
  logout                         Revoke this machine's session
  whoami                         Show the signed-in account

  projects [list]                List projects in your workspace
  projects create --name <n> --item-id <id> --visibility private|unlisted
  init --project <id>            Link the current folder to a project (writes extshare.json)

  validate [dir|zip]             Check a build locally without uploading
  publish [dir|zip]              Upload, submit to the Chrome Web Store, and create a share link
      --ttl 7d                   Test window (15m to 90d)
      --testers a@x.com,b@y.com  Google accounts allowed through the share link
      --notes <text>  --staged  --no-inherit-testers  --strict-source-maps  --wait

  releases [--project <id>]      List releases
  status <release> [--sync]      Show a release, optionally re-checking the Web Store
  invite <release> [--ttl 2d]    Replace the share link (old links stop working)
  testers <release> [--add ..] [--remove ..]
  extend <release> --ttl 3d      Move the end of the test window
  revoke <release> [--reason ..] [--kill-switch --yes] [--no-cancel]
  audit <release>                Show the release's audit trail
  download <release> [-o file]   Download the exact uploaded package
`;

const COMMANDS: Record<string, (ctx: CliContext, args: string[]) => Promise<void>> = {
  login: cmd.login,
  logout: (ctx) => cmd.logout(ctx),
  whoami: (ctx) => cmd.whoami(ctx),
  projects: cmd.projects,
  init: cmd.init,
  validate: cmd.validate,
  publish: cmd.publish,
  status: cmd.status,
  releases: cmd.releases,
  invite: cmd.invite,
  testers: cmd.testers,
  extend: cmd.extend,
  revoke: cmd.revoke,
  audit: cmd.audit,
  download: cmd.download,
};

/** Runs one CLI invocation and returns its exit code. Never calls process.exit, so tests can drive it. */
export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const args = argv.filter((a) => a !== "--json");
  const json = args.length !== argv.length;
  const [name, ...rest] = args;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    ctx.out(HELP);
    return 0;
  }
  if (name === "--version" || name === "version") {
    ctx.out("extshare 0.1.0");
    return 0;
  }
  const handler = COMMANDS[name];
  if (!handler) {
    ctx.err(`Unknown command: ${name}\n\n${HELP}`);
    return 2;
  }
  try {
    await handler({ ...ctx, json }, rest);
    return 0;
  } catch (e) {
    if (e instanceof ApiError) {
      ctx.err(`error: ${e.message}${e.code !== "http_error" ? ` [${e.code}]` : ""}`);
      return e.exitCode;
    }
    if (e instanceof CliError) {
      ctx.err(`error: ${e.message}`);
      for (const d of e.detail ?? []) ctx.err(`  ${d}`);
      return e.exitCode;
    }
    const code = (e as { code?: unknown }).code;
    if (
      (typeof code === "string" &&
        /ConnectionRefused|ConnectionClosed|FailedToOpenSocket|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|CERT/i.test(
          code,
        )) ||
      (e instanceof Error && /Unable to connect/i.test(e.message))
    ) {
      ctx.err(`error: could not reach the server (${e instanceof Error ? e.message : String(e)})`);
      return 4;
    }
    throw e;
  }
}

function openBrowser(url: string) {
  const cmdline =
    process.platform === "win32"
      ? ["rundll32", "url.dll,FileProtocolHandler", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmdline, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // The URL is printed too; failing to launch a browser is not an error.
  }
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    configDir: defaultConfigDir(),
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    openBrowser,
    json: false,
  });
  process.exit(code);
}
