---
title: Server configuration
order: 4
description: Environment variables, tester sign-in, HTTPS, Docker, accounts, backups and upgrades.
---

# Server configuration

The server is a single process, published as a [Docker image](#docker). It keeps a SQLite database and the uploaded packages in `DATA_DIR`, so it needs a persistent disk: a VPS, or a container host with a mounted volume. It also runs a background job that checks the Web Store and closes expired releases.

## Environment variables

Put your settings in a `.env` file, starting from the commented [.env.example](https://github.com/arslan-ahm/extshare/blob/main/.env.example). Docker reads it through `--env-file`; when you [run from source](#run-from-source), Bun loads it automatically.

| Variable                                                  | Required    | Meaning                                                                                                                                   |
| --------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                                              | yes         | Public origin, for example `https://extshare.example.com`. Must be `https://` except for localhost. Share links and the CLI login use it. |
| `SECRET`                                                  | yes         | At least 32 characters. Signs short-lived cookies. Generate with `openssl rand -base64 48`.                                               |
| `CWS_PUBLISHER_ID`                                        | yes         | Your Web Store publisher ID.                                                                                                              |
| `CWS_SERVICE_ACCOUNT_FILE`                                | one of      | Path to the service account JSON key.                                                                                                     |
| `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` | one of      | OAuth client and refresh token, as an alternative to the service account.                                                                 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                | for testers | OAuth client used for tester sign-in. Without it, share links cannot sign anyone in.                                                      |
| `DATA_DIR`                                                | no          | Database and package storage. Default `./data`, or `/data` in the Docker image. Back it up.                                                                               |
| `HOST`, `PORT`                                            | no          | Listen address. Default `127.0.0.1:8787`, or `0.0.0.0:8787` in the Docker image.                                                                                                 |
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

The server is published as a container image for `linux/amd64` and `linux/arm64`: `ghcr.io/arslan-ahm/extshare`. Use `latest`, or pin a release such as `0.1.0`.

```bash
docker run -d --name extshare --restart unless-stopped   --env-file .env -v extshare-data:/data   -p 127.0.0.1:8787:8787 ghcr.io/arslan-ahm/extshare:latest
```

The image listens on `0.0.0.0:8787` inside the container and keeps its data in the `/data` volume, so leave `HOST` and `DATA_DIR` out of the `.env` you pass to it. Publishing the port on `127.0.0.1` keeps it private to the reverse proxy.

To use a service account key, mount it read-only and point at it. The container runs as a non-root user, so the file must be readable by others (`chmod 644`); keep it in a directory only you can open.

```bash
docker run -d --name extshare --restart unless-stopped   --env-file .env -v extshare-data:/data   -v "$PWD/cws-key.json:/run/secrets/cws-key.json:ro"   -p 127.0.0.1:8787:8787 ghcr.io/arslan-ahm/extshare:latest
# .env: CWS_SERVICE_ACCOUNT_FILE=/run/secrets/cws-key.json
```

If the configuration is incomplete the container exits, and `docker logs extshare` lists every problem. Any container host works if `/data` is a persistent volume. Serverless platforms without a persistent disk do not.

## Accounts

```bash
docker exec -it extshare bun admin.js create-user --email <email> --name <name> --workspace-name <name> --role owner
docker exec -it extshare bun admin.js create-user --email <email> --name <name> --workspace-id <id> --role publisher
docker exec -it extshare bun admin.js reset-mfa --email <email>
```

`create-user` asks for the password without echoing it. Roles: **owner** and **publisher** can create projects, publish, change testers, share, extend and revoke. **Viewer** can read everything in the workspace. `reset-mfa` clears a lost authenticator and signs the user out everywhere, including the CLI.

## Backups and upgrades

Back up the `/data` volume: `extshare.db` (with its `-wal` file) and `artifacts/`. For a consistent copy, stop the container first.

Database migrations run automatically at start-up and are recorded in the database. To upgrade, pull the new image and recreate the container; the volume keeps your data:

```bash
docker pull ghcr.io/arslan-ahm/extshare:latest
docker rm -f extshare
docker run -d --name extshare --restart unless-stopped   --env-file .env -v extshare-data:/data   -p 127.0.0.1:8787:8787 ghcr.io/arslan-ahm/extshare:latest
```

## Run from source

For development, or to run without Docker, use [Bun](https://bun.sh) 1.3 or newer:

```bash
git clone https://github.com/arslan-ahm/extshare.git
cd extshare
bun install
cp .env.example .env      # fill it in
bun run server            # the server
bun run admin create-user --email you@example.com --name "You" --workspace-name "My Team" --role owner
bun run verify:sqlite     # checks the database layer against real SQLite, using temporary files
```

Upgrading from source is: pull, `bun install`, restart.
