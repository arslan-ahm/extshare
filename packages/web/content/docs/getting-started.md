---
title: Getting started
order: 2
description: Install the extshare server and CLI, create your account, and publish your first test build.
---

# Getting started

You need a server with a persistent disk and HTTPS (macOS or Linux, or Docker), a Chrome Web Store developer account, and a Google Cloud project. Everything else is installed for you.

## 1. Prepare the Chrome Web Store item

Create the extension's item once in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole/), fill in the **Store listing** and **Privacy** tabs, and choose its visibility (Private or Unlisted). Note the 32-letter item ID. Then create publishing credentials. Both steps are covered in [Chrome Web Store setup](/docs/web-store).

## 2. Install and start the server

On your server:

```bash
curl -fsSL https://extshare.vercel.app/install.sh | sh -s -- server
```

This installs the `extshare-server` command. It runs on [Bun](https://bun.sh), which the installer sets up first if it is missing. Then create a folder for the server, put a `.env` file with your settings in it ([Server configuration](/docs/server) lists every variable, and the repository has a commented [.env.example](https://github.com/arslan-ahm/extshare/blob/main/.env.example) to start from), and start it there:

```bash
mkdir -p ~/extshare && cd ~/extshare     # your .env goes here
extshare-server
```

If a setting is missing, it stops and lists what to fix. To keep it running and put it behind HTTPS, see [Server configuration](/docs/server#keep-it-running), which also covers [Docker](/docs/server#docker).

## 3. Create your account

From the same folder:

```bash
extshare-server admin create-user --email you@example.com --name "You" --workspace-name "My Team" --role owner
```

Open your server's URL and sign in. The first sign-in asks you to scan a QR code with an authenticator app; every dashboard account uses two-factor authentication.

## 4. Install the CLI

On your own computer. macOS and Linux:

```bash
curl -fsSL https://extshare.vercel.app/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://extshare.vercel.app/install.ps1 | iex
```

The installer checks the download against its SHA-256 checksum, installs the `extshare` command, and tells you if it needs adding to your `PATH`. Check it with `extshare --version`. The [CLI reference](/docs/cli#install) has the details.

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
