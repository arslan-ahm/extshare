---
title: Introduction
order: 1
description: What extshare does, how a test build travels from your machine to a tester's Chrome, and what Chrome itself decides.
---

# Introduction

extshare publishes Chrome extension test builds from the command line and shares them with testers through a link that checks who they are and expires when the test ends. Testers install from the Chrome Web Store like any other extension, so permissions, updates and removal all behave normally.

You run extshare on your own server. It holds your Chrome Web Store publishing credentials, so neither your CLI nor your testers ever see them.

## How a build travels

1. **Publish.** `extshare publish ./dist` packages your build, checks it locally, and uploads it. The server checks it again: ZIP safety, Manifest V3 rules, leaked credentials, remotely hosted code.
2. **Review.** The server uploads the package to your Chrome Web Store item and submits it. Most versions go through Web Store review. extshare polls the store and moves the release to `live` when it is approved.
3. **Share.** You get a share link. A tester opens it, signs in with Google, and if their address is on the release's tester list they see an **Open in Chrome Web Store** button.
4. **Revoke or expire.** When the test window ends, or you revoke the release, every link stops working. The optional kill switch pushes an inert update to copies that are already installed.

## What Chrome decides

Some limits come from Chrome and the Web Store, not from extshare. They shape how you use it:

- **Installs always go through the Web Store.** A share link is an authorization page, not an installer.
- **One project is one Web Store item.** You create the item once in the Developer Dashboard; the API cannot create items or change their visibility.
- **Private items** install only for Google accounts on the item's trusted-tester list, which you manage in the Developer Dashboard (a Google Group makes this easy). **Unlisted items** install for anyone holding the store URL; extshare controls who sees that URL.
- **Reviews take time**, usually hours to a few days. Testers see a "not ready yet" page until the build is live.
- **Installed copies stay installed** until the tester removes them or the kill switch update reaches them.
- **Shipped code is readable** by anyone who installs it. Keep secrets on your servers.

Read [Getting started](/docs/getting-started) to set it up.
