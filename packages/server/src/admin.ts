import { join } from "node:path";
import { parseArgs } from "node:util";
import { AppError, type Deps } from "./context";
import { RateLimiter, randomToken, Signer } from "./security";
import { AuthService } from "./services/auth";
import { SqliteStore } from "./store/sqlite";
import type { Role } from "./store/types";

const USAGE = `extshare admin

  create-user --email <email> --name <name> (--workspace-name <name> | --workspace-id <id>) [--role owner|publisher|viewer]
      Prompts for a password (min 12 characters). The user sets up two-factor authentication at first sign-in.
  reset-mfa --email <email>
      Clears two-factor authentication and ends the user's sessions and CLI tokens.

Environment: DATA_DIR (default ./data)`;

async function readPassword(): Promise<string> {
  const fromEnv = process.env.EXTSHARE_ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) throw new Error("No TTY: set EXTSHARE_ADMIN_PASSWORD instead");
  process.stdout.write("Password (min 12 characters, not shown): ");
  const answer = await new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (ch === "\u0003") {
          cleanup();
          return reject(new Error("Cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
  if (!answer) throw new Error("No password given");
  return answer;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: "string" },
      name: { type: "string" },
      "workspace-name": { type: "string" },
      "workspace-id": { type: "string" },
      role: { type: "string", default: "owner" },
    },
  });
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  const store = SqliteStore.open(join(process.env.DATA_DIR ?? "./data", "extshare.db"));
  const now = () => Date.now();
  // Admin commands only touch the user tables; the remaining dependencies are inert placeholders.
  const deps = {
    store,
    now,
    limiter: new RateLimiter(now),
    signer: new Signer(randomToken(32)),
    log: () => {},
  } as unknown as Deps;
  const auth = new AuthService(deps);
  try {
    if (cmd === "create-user") {
      if (!values.email) throw new Error("--email is required");
      const role = values.role as Role;
      if (!["owner", "publisher", "viewer"].includes(role))
        throw new Error("--role must be owner, publisher or viewer");
      const password = await readPassword();
      const r = await auth.createUser({
        email: values.email,
        name: values.name ?? values.email,
        password,
        workspaceName: values["workspace-name"],
        workspaceId: values["workspace-id"],
        role,
      });
      console.log(
        `Created user ${r.userId} in workspace ${r.workspaceId}. They will enroll an authenticator app at first sign-in.`,
      );
    } else if (cmd === "reset-mfa") {
      if (!values.email) throw new Error("--email is required");
      auth.resetMfa(values.email);
      console.log("Two-factor authentication reset; sessions and CLI tokens revoked.");
    } else {
      console.error(USAGE);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`error: ${e instanceof AppError || e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

await main();
