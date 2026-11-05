---
title: Server configuration
order: 4
description: Environment variables, tester sign-in, HTTPS, Docker, accounts, backups and upgrades.
---

# Server configuration

The server is a single Bun process. It keeps a SQLite database and the uploaded packages in `DATA_DIR`, so it needs a persistent disk: a VPS, or a container host with a mounted volume. It also runs a background job that checks the Web Store and closes expired releases.

## Environment variables

Copy `.env.example` to `.env`. Bun loads it automatically.

| Variable                                                  | Required    | Meaning                                                                                                                                   |
| --------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                                              | yes         | Public origin, for example `https://extshare.example.com`. Must be `https://` except for localhost. Share links and the CLI login use it. |
| `SECRET`                                                  | yes         | At least 32 characters. Signs short-lived cookies. Generate with `openssl rand -base64 48`.                                               |
| `CWS_PUBLISHER_ID`                                        | yes         | Your Web Store publisher ID.                                                                                                              |
| `CWS_SERVICE_ACCOUNT_FILE`                                | one of      | Path to the service account JSON key.                                                                                                     |
| `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` | one of      | OAuth client and refresh token, as an alternative to the service account.                                                                 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                | for testers | OAuth client used for tester sign-in. Without it, share links cannot sign anyone in.                                                      |
| `DATA_DIR`                                                | no          | Database and package storage. Default `./data`. Back it up.                                                                               |
| `HOST`, `PORT`                                            | no          | Listen address. Default `127.0.0.1:8787`.                                                                                                 |
| `TRUST_PROXY`                                             | no          | `true` behind a reverse proxy you control, so logs and rate limits see real client IPs.                                                   |
| `SYNC_INTERVAL_SEC`                                       | no          | How often to check the Web Store and expire releases. Default `120`, minimum `30`.                                                        |

The server refuses to start, and lists every problem, when the configuration is incomplete.

## Tester sign-in

Testers prove their identity with Google. In Google Cloud, create an OAuth client of type **Web application**:

- Authorized redirect URI: `https://<your host>/auth/google/callback`
- Scopes: `openid` and `email`

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. While the OAuth consent screen is in testing mode, only the Google accounts you list there can sign in; publish the consent screen before inviting outside testers.

## HTTPS and reverse proxy

`deploy/Caddyfile` is a working config. Caddy obtains certificates automatically, allows uploads up to 70 MB, and passes the client address. Set `TRUST_PROXY=true` behind it.

```
extshare.example.com {
	request_body {
		max_size 70MB
	}
	reverse_proxy 127.0.0.1:8787 {
		header_up X-Forwarded-For {remote_host}
	}
}
```

## Docker

```bash
docker build -t extshare .
docker run -d --name extshare --env-file .env -v extshare-data:/data -p 127.0.0.1:8787:8787 extshare
docker exec -it extshare bun admin.js create-user --email you@example.com --workspace-name "My Team"
```

Any container host works if `/data` is a persistent volume. Serverless platforms without a persistent disk do not.

## Accounts

```bash
bun run admin create-user --email <email> --name <name> --workspace-name <name> --role owner
bun run admin create-user --email <email> --name <name> --workspace-id <id> --role publisher
bun run admin reset-mfa --email <email>
```

Roles: **owner** and **publisher** can create projects, publish, change testers, share, extend and revoke. **Viewer** can read everything in the workspace. `reset-mfa` clears a lost authenticator and signs the user out everywhere, including the CLI.

## Backups and upgrades

Back up `DATA_DIR`: `extshare.db` (with its `-wal` file) and `artifacts/`. For a consistent copy, stop the server or use `sqlite3 extshare.db ".backup backup.db"`.

Database migrations run automatically at start-up and are recorded in the database, so upgrading is: pull, `bun install`, restart.
