# extshare

Publish Chrome extension test builds from the command line and share them with testers through a secure, expiring link. Testers install from the Chrome Web Store like any other extension, get automatic updates, and lose access when the test window ends.

```
developer                      extshare server                         Chrome Web Store
---------                      ---------------                         ----------------
extshare publish ./dist  --->  validate + scan package
                               store artifact (sha256)
                               upload + submit  ---------------------> review (private / unlisted item)
                               share link  <--- status sync ---------- live
tester opens link        --->  Google sign-in, allowlist check
                               "Open in Chrome Web Store"  ----------> Add to Chrome, auto-updates
extshare revoke          --->  links dead, submission cancelled,
                               optional kill-switch build  ----------> review, then installed copies go inert
```

## How it works, and the limits that come from Chrome

- **Installation always goes through the Chrome Web Store.** The share link is an authorization page, not an installer. Chrome only installs extensions from the Web Store or enterprise policy, so the link checks who the tester is and then shows the store's install button.
- **One project = one Web Store item.** You create the item once by hand in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole/) (the API cannot create items), fill in the Store listing and Privacy tabs, and set its visibility:
  - **Private**: only Google accounts on the item's trusted-tester list (or a Google Group / Workspace domain you add there) can install. The Web Store API cannot edit that list, so keep it in sync with the testers you add in extshare. A Google Group is the easiest way.
  - **Unlisted**: anyone with the store URL can install. extshare still gates who sees the URL, but a tester can forward it.
- **Reviews are asynchronous.** New versions usually go into review. A release moves `uploading -> processing -> in_review -> live` (or `rejected`), and testers see a "not ready yet" page until it is live. extshare polls the store every `SYNC_INTERVAL_SEC`.
- **Revocation stops new installs instantly; existing installs need more.** Revoking kills every share link at once. Copies already installed keep working until the tester removes them, unless you use the **kill switch**, which publishes an empty successor version that installed copies auto-update to after review. On managed devices, use Chrome enterprise policy to force-remove.
- **Shipped code is readable.** Anything inside an extension can be unpacked by whoever installs it. extshare refuses packages containing credentials, keys, `.env` files or remotely hosted code, and warns about source maps. Keep secrets and business logic on your servers.
- **No remote code.** Manifest V3 forbids loading JavaScript or WASM from the network. extshare blocks `importScripts`/`import()`/`<script src>` of remote URLs and CSPs that allow remote script sources. Remote JSON or config data is fine.

## Install

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run check          # typecheck + lint + tests
bun run build:cli      # standalone binary at dist/extshare(.exe)
```

## Server setup

### 1. Chrome Web Store credentials

The server publishes on your behalf with the Chrome Web Store API v2. Either:

- **Service account (recommended).** Create a service account in Google Cloud, enable the Chrome Web Store API, download its JSON key, and add the service account's email in the Developer Dashboard under **Account**. Set `CWS_SERVICE_ACCOUNT_FILE`.
- **OAuth refresh token.** Create an OAuth client (Web application) with `https://developers.google.com/oauthplayground` as a redirect URI, then use the OAuth Playground with scope `https://www.googleapis.com/auth/chromewebstore` to get a refresh token. Set `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`.

`CWS_PUBLISHER_ID` is shown under **Publisher > Settings** in the Developer Dashboard. Google requires 2-step verification on the publisher account.

### 2. Google sign-in for testers

Create a second OAuth client (Web application) with redirect URI `https://<your host>/auth/google/callback` and scopes `openid email`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Without these, share links cannot authenticate anyone.

### 3. Configure and run

```bash
cp .env.example .env     # fill it in; SECRET: openssl rand -base64 48
bun run server           # reads .env automatically
```

Run it behind HTTPS. `deploy/Caddyfile` is a ready reverse-proxy config; set `TRUST_PROXY=true` behind it. Or use Docker:

```bash
docker build -t extshare .
docker run -d --env-file .env -v extshare-data:/data -p 127.0.0.1:8787:8787 extshare
```

### 4. Create the first publisher account

```bash
bun run admin create-user --email you@example.com --name "You" --workspace-name "My Team" --role owner
# Docker: docker exec -it <container> bun admin.js create-user ...
```

Sign in at `PUBLIC_URL`. The first sign-in enrols an authenticator app (TOTP is mandatory for every dashboard account). Add teammates with `--workspace-id <id>` and `--role publisher` or `--role viewer`. Lost authenticator: `bun run admin reset-mfa --email ...`.

### 5. Verify the database layer (owner step)

The automated tests exercise every flow against an in-memory store and check the SQLite mapping against the migration file. They never open a real database. Once, on the machine you deploy to, run the same store contract against real SQLite (it uses throwaway files in your temp directory and deletes them):

```bash
bun run verify:sqlite
```

## Using the CLI

```bash
extshare login --server https://extshare.example.com      # approve in the browser
extshare projects create --name "My Ext" --item-id <32-char id> --visibility private
cd my-extension && extshare init --project <project id>

extshare validate ./dist
extshare publish ./dist --ttl 7d --testers alice@example.com,bob@example.com --notes "checkout fix"
#   prints the share link once; send it to your testers

extshare status <release> --sync
extshare testers <release> --add carol@example.com --remove bob@example.com
extshare invite <release>                     # new link; old ones stop working
extshare extend <release> --ttl 3d
extshare revoke <release> --reason "test over" [--kill-switch --yes]
extshare audit <release>
extshare download <release> -o build.zip      # the exact bytes that were published
```

Every command accepts `--json`. Exit codes: `0` ok, `1` failure, `2` usage error, `3` not logged in or session revoked, `4` server unreachable.

For private items, also add each tester's Google account to the item's trusted testers in the Developer Dashboard (or add a Google Group there once and manage membership in Google Groups).

## Security model

| Area | Control |
| --- | --- |
| Publisher accounts | argon2id passwords, mandatory TOTP with replay protection, 12 h sessions, `__Host-` HttpOnly Secure SameSite cookies, CSRF token and Origin check on every form, login rate limits |
| CLI | Device-code login approved in the browser; 1 h access tokens; 30 day rotating refresh tokens; reusing a rotated refresh token revokes the whole login (theft signal); credentials file written 0600 |
| Authorization | Every project and release lookup is scoped to the caller's workspace (other workspaces get 404). Roles: owner, publisher, viewer |
| Packages | ZIP checked before decompression (path traversal, absolute paths, symlinks, duplicates, size and ratio limits), MV3 and Web Store manifest rules, secret and remote-code scanning, SHA-256 verified end to end, content-addressed storage |
| Share links | 256-bit random tokens stored only as SHA-256 hashes, shown once, expire with the release, rotate on demand; Google sign-in (PKCE, nonce, verified email); allowlist decided per visit; release state revealed only to authorised testers; `Referrer-Policy: no-referrer` so tokens never leak to the store |
| Store credentials | Held only by the server, never sent to the CLI |
| Audit | Append-only log (enforced by database triggers) of publishes, state changes, link visits and decisions, tester changes, revocations, logins |
| HTTP | Strict CSP with no scripts at all, frame denial, HSTS, no-store caching for dynamic pages |

## Project layout

```
packages/core     validation, scanning, lifecycle and access rules (pure functions, shared)
packages/server   Bun + Hono server: API, dashboard, tester gateway, Web Store client, stores
packages/cli      the extshare command
```

## Development

```bash
bun test                    # all tests
bun run typecheck
bun run lint
```

Tests use hand-written fixtures and in-memory fakes for the Web Store and Google. They never call Google or write to a database.
