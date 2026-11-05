/**
 * `extshare-server` entry point (bundled into one file by the website build and served from /download).
 *   extshare-server                 start the server (configuration from the environment / .env)
 *   extshare-server admin <command> account administration (see admin.ts)
 *   extshare-server --version
 * Each module runs on import, so only the one that was asked for is loaded.
 */
import pkg from "../package.json" with { type: "json" };

export const SERVER_VERSION: string = pkg.version;

const [first] = process.argv.slice(2);
if (first === "--version" || first === "version") {
  console.log(`extshare-server ${SERVER_VERSION}`);
} else if (first === "--help" || first === "-h" || first === "help") {
  console.log(`extshare-server ${SERVER_VERSION}

  extshare-server                  Start the server. Settings come from the environment or a .env file
                                   in the current directory; see https://extshare.vercel.app/docs/server
  extshare-server admin <command>  Manage accounts (create-user, reset-mfa); run "extshare-server admin" for details
  extshare-server --version        Print the version`);
} else if (first === "admin") {
  // admin.ts reads its command from argv[2].
  process.argv.splice(2, 1);
  await import("./admin");
} else {
  await import("./main");
}
