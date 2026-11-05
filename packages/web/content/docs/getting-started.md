---
title: Getting started
order: 2
description: Run the extshare server, create your account, install the CLI, and publish your first test build.
---

# Getting started

You need a server with Docker, a persistent disk and HTTPS, a Chrome Web Store developer account, and a Google Cloud project.

## 1. Prepare the Chrome Web Store item

Create the extension's item once in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole/), fill in the **Store listing** and **Privacy** tabs, and choose its visibility (Private or Unlisted). Note the 32-letter item ID. Then create publishing credentials. Both steps are covered in [Chrome Web Store setup](/docs/web-store).

## 2. Run the server

Create a `.env` file with your settings. [Server configuration](/docs/server) lists every variable, and the repository has a commented [.env.example](https://github.com/arslan-ahm/extshare/blob/main/.env.example) to start from. Then start the published image:

```bash
docker run -d --name extshare --restart unless-stopped \
  --env-file .env -v extshare-data:/data \
  -p 127.0.0.1:8787:8787 ghcr.io/arslan-ahm/extshare:latest
```

If a setting is missing, the container stops and `docker logs extshare` lists what to fix. Put the server behind HTTPS; [Server configuration](/docs/server#https-and-reverse-proxy) has a ready Caddy config.

## 3. Create your account

```bash
docker exec -it extshare bun admin.js create-user \
  --email you@example.com --name "You" --workspace-name "My Team" --role owner
```

Open your server's URL and sign in. The first sign-in asks you to scan a QR code with an authenticator app; every dashboard account uses two-factor authentication.

## 4. Install the CLI

macOS and Linux:

```bash
curl -fsSL https://extshare.vercel.app/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://extshare.vercel.app/install.ps1 | iex
```

The installer downloads the binary for your system from the [latest release](https://github.com/arslan-ahm/extshare/releases/latest), checks it against the release's SHA-256 checksums, and puts it on your `PATH`. Check it with `extshare --version`. The [CLI reference](/docs/cli#install) covers other versions and install locations.

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
