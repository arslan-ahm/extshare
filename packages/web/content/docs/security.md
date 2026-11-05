---
title: Security model
order: 8
description: How extshare protects accounts, packages, share links and credentials, and what it cannot protect.
---

# Security model

## Publisher accounts

- Passwords are hashed with argon2id. Sign-in is rate limited per address and per account.
- Two-factor authentication (TOTP) is mandatory for every dashboard account, and a code cannot be used twice.
- Sessions last 12 hours in `HttpOnly`, `Secure`, `SameSite=Lax` cookies with the `__Host-` prefix.
- Every form checks a per-session CSRF token and the request's `Origin`.

## The CLI

- Device login: the CLI never sees your password or second factor; you approve it in a signed-in browser.
- Access tokens last one hour. Refresh tokens last 30 days and rotate on every use. Presenting a refresh token that was already used revokes every token from that login, because it means the token was copied.
- `logout` revokes tokens on the server. Tokens are stored only as hashes on the server.

## Authorization

Every project and release lookup is limited to the caller's workspace; anything else returns "not found". Owners and publishers can change things; viewers can only read.

## Packages

- The ZIP is inspected before it is decompressed: no absolute paths, `..` segments, backslashes, symlinks, duplicate names, encrypted entries or unsupported compression; limits on size, entry count and compression ratio.
- Each entry is decompressed only up to its declared size and must match its CRC-32.
- Manifest V3 and Web Store rules are enforced, including no remotely hosted code (`importScripts`, `import()` or `<script src>` of remote URLs, and remote script sources in the CSP).
- Packages containing private keys, cloud and API credentials, `.env` files or key files are refused. Source maps produce a warning, or an error with `--strict-source-maps`.
- The SHA-256 of the package is computed by the CLI, checked by the server, recorded, and used as the storage key. `extshare download` re-checks it.

## Share links

- 256-bit random tokens, stored only as hashes, shown once, closed when the release expires or is revoked, replaceable at any time.
- Testers sign in with Google (authorization code flow with PKCE and a nonce); only verified addresses are accepted.
- Nothing about the release is shown before sign-in, and its status is shown only to listed testers.
- Pages are sent with `Referrer-Policy: no-referrer`, so the token never leaks to the Web Store or anywhere else through the `Referer` header.

## Credentials

Web Store and Google credentials live only on the server. The CLI and testers never receive them.

## Audit log

Sign-ins, device approvals, publishes, state changes, tester changes, link creation, every decision on a share link, revocations and kill switches are recorded with actor, time and IP. The database refuses updates and deletes on the audit table.

## HTTP

A strict Content Security Policy with no scripts at all, framing denied, HSTS, `nosniff`, and `no-store` caching for dynamic pages.

## What extshare cannot protect

- **Your extension's code.** Anyone who installs it can unpack and read it. Keep secrets and sensitive logic on your servers.
- **Copies already installed** after you revoke, until they are removed or the kill switch update reaches them.
- **Unlisted store URLs** that a tester forwards. Use a private item when that matters.
