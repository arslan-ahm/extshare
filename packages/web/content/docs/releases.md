---
title: Releases and lifecycle
order: 6
description: Release states, test windows, share links, testers, revoking and the kill switch.
---

# Releases and lifecycle

Each `publish` creates a release: one version of your extension with its own tester list, test window and share links.

## States

| State        | Meaning                                                                                  | Testers see        |
| ------------ | ---------------------------------------------------------------------------------------- | ------------------ |
| `uploading`  | Sending the package to the Web Store                                                     | Not ready yet      |
| `processing` | The Web Store is still processing the upload; extshare submits it as soon as it finishes | Not ready yet      |
| `in_review`  | Submitted and waiting for Web Store review                                               | Not ready yet      |
| `staged`     | Approved, waiting for you to publish it in the Developer Dashboard (`--staged`)          | Not ready yet      |
| `live`       | Installable from the Web Store                                                           | The install button |
| `rejected`   | The Web Store rejected it; the reason is in the Developer Dashboard                      | Unavailable        |
| `cancelled`  | The submission was cancelled                                                             | Unavailable        |
| `failed`     | Upload or submission failed; the reason is shown on the release                          | Unavailable        |
| `superseded` | A newer version from this project is now live on the item                                | Unavailable        |
| `expired`    | The test window ended                                                                    | Link closed        |
| `revoked`    | You revoked it                                                                           | Link closed        |

The server checks the Web Store every `SYNC_INTERVAL_SEC` seconds. To check immediately, run `extshare status <release> --sync` or press **Check now** in the dashboard.

Versions must always increase. The Web Store refuses a version that is not higher than the last one uploaded to the item, and extshare checks this before uploading. A release that failed before reaching the store does not use up its version number.

## Test window

`--ttl` sets how long links work, from 15 minutes to 90 days. Extend it with `extshare extend <release> --ttl 3d` (the new window starts now) as long as the release is not expired or revoked. When it ends the release becomes `expired` and its links stop working. Expired releases cannot be reopened; publish a new version instead.

## Testers

Testers are Google account emails, kept per release. A new release inherits the previous release's testers unless you pass `--no-inherit-testers`. Change them with `extshare testers <release> --add a@x.com --remove b@y.com` or in the dashboard. Changes apply on the tester's next visit to the link.

For private items, the Web Store also needs these accounts on the item's trusted-tester list. See [Chrome Web Store setup](/docs/web-store).

## Share links

A share link is a random 256-bit token. The server stores only its hash, so it is shown once: in the CLI output when you publish, or on the release page right after you press **Create link**. Creating a new link disables every earlier link for that release. Links expire with the release.

## Revoking

`extshare revoke <release> --reason "..."` closes the release immediately: every link stops working and the reason goes into the audit log. If the release was still in review and is the newest submission, extshare also cancels the Web Store submission (skip this with `--no-cancel`).

Copies that are already installed keep running. To reach them, use the kill switch.

## Kill switch

`extshare revoke <release> --kill-switch --yes` also publishes a **withdrawal build**: the next version number, the same name, no permissions, no scripts, and a popup saying the test ended. Chrome updates installed copies to it automatically once the Web Store approves it, which takes as long as any review.

The withdrawal replaces the item's current build **for everyone who has it installed**, so it is only allowed on the newest build on the item. For an older release, revoke without the kill switch.
