---
title: Getting started
order: 2
description: Deploy the extshare server, create your account, and publish your first test build.
---

# Getting started

You need [Bun](https://bun.sh) 1.3 or newer, a server with a persistent disk and HTTPS, a Chrome Web Store developer account, and a Google Cloud project.

## 1. Prepare the Chrome Web Store item

Create the extension's item once in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole/), fill in the **Store listing** and **Privacy** tabs, and choose its visibility (Private or Unlisted). Note the 32-letter item ID. Then create publishing credentials. Both steps are covered in [Chrome Web Store setup](/docs/web-store).

## 2. Deploy the server

```bash
git clone https://github.com/arslan-ahm/extshare.git
cd extshare
bun install
cp .env.example .env    # fill it in, see Server configuration
bun run server
```

Put it behind HTTPS. The repository includes a Dockerfile and a Caddy reverse-proxy config; see [Server configuration](/docs/server).

Once, on the machine you deploy to, check the database layer against real SQLite. It uses throwaway files in your temp directory:

```bash
bun run verify:sqlite
```

## 3. Create your account

```bash
bun run admin create-user --email you@example.com --name "You" --workspace-name "My Team" --role owner
```

Open your server's URL and sign in. The first sign-in asks you to scan a QR code with an authenticator app; every dashboard account uses two-factor authentication.

## 4. Install the CLI

```bash
bun run build:cli          # produces dist/extshare (dist/extshare.exe on Windows)
```

Put the binary on your `PATH`, or run commands from the repository with `bun run cli <command>`.

## 5. Publish your first build

```bash
extshare login --server https://extshare.example.com
extshare projects create --name "My Extension" --item-id <item id> --visibility private
cd path/to/your-extension
extshare init --project <project id>
extshare publish ./dist --ttl 7d --testers alice@example.com,bob@example.com
```

`publish` prints a share link once. Send it to your testers. For a private item, also add those Google accounts to the item's trusted testers in the Developer Dashboard.

Check progress with `extshare status <release> --sync`, or open the release in the dashboard.
