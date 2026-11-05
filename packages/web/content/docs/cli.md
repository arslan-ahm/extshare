---
title: CLI reference
order: 5
description: Every extshare command, its options, output and exit codes.
---

# CLI reference

This is the CLI's own help text, taken from the source at build time:

```
{{CLI_HELP}}
```

## Signing in

`extshare login --server <url>` starts a device login: the CLI prints a URL and a code, opens your browser, and waits while you approve it in the dashboard (you must be signed in there with two-factor authentication). Pass `--no-browser` to only print the URL.

The CLI stores its tokens in `credentials.json` inside your config directory, readable only by you:

- Windows: `%APPDATA%\extshare`
- macOS and Linux: `$XDG_CONFIG_HOME/extshare`, or `~/.config/extshare`
- Override with `EXTSHARE_CONFIG_DIR`

Access tokens last an hour and refresh automatically for 30 days. `extshare logout` revokes the session on the server, not just the local file.

## Project folders

`extshare init --project <id>` writes `extshare.json` in the current folder with the server URL and project ID. Commit it if your team shares the project. Commands that need a project read it, or take `--project`. If the file names a different server than the one you are logged in to, the CLI stops and tells you which server to log in to.

## Publishing

`extshare publish [dir|zip]` accepts a build directory (its contents become the package root, so pass `./dist`, not the folder above it) or a ready-made `.zip`. When packaging a directory it skips `.git`, `node_modules`, `.DS_Store`, `Thumbs.db`, `desktop.ini` and `extshare.json`, and refuses symlinks.

It validates locally first and uploads nothing if the package has errors. The server validates again and only trusts its own result.

| Option                 | Default              | Meaning                                                                                             |
| ---------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| `--ttl`                | `7d`                 | Test window: minutes (`m`), hours (`h`) or days (`d`), combinable (`1d12h`). 15 minutes to 90 days. |
| `--testers`            | none                 | Comma-separated Google account emails. Added to the testers inherited from the previous build.      |
| `--no-inherit-testers` | off                  | Start this release with only `--testers`.                                                           |
| `--notes`              | empty                | Free text shown in the dashboard.                                                                   |
| `--staged`             | off                  | Ask the Web Store to stage the version after approval instead of publishing it immediately.         |
| `--strict-source-maps` | off                  | Treat shipped `.map` files as errors.                                                               |
| `--wait`               | off                  | Keep checking the Web Store every 30 seconds until the review ends.                                 |
| `--project`            | from `extshare.json` | Project to publish to.                                                                              |
| `--visibility`         | none                 | Safety check only: fail if the item's visibility is not this.                                       |

The share link is printed once. Make a new one any time with `extshare invite <release>`; that disables earlier links.

## Machine output and exit codes

Add `--json` to any command for JSON on stdout. Messages and warnings go to stderr.

| Code | Meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| `0`  | Success                                                                                  |
| `1`  | The operation failed (validation errors, server refused, release failed or was rejected) |
| `2`  | Bad command line, or a confirmation such as `--yes` is missing                           |
| `3`  | Not logged in, or the session expired or was revoked                                     |
| `4`  | The server could not be reached                                                          |
