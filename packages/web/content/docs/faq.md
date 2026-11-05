---
title: FAQ
order: 9
description: Answers to common questions about installs, reviews, hosting and limits.
---

# FAQ

## Can a link install the extension directly, without the Web Store?

No. Chrome installs extensions only from the Chrome Web Store or through enterprise policy. The link checks who the tester is and then sends them to the store page.

## Can the extension download its code from my server so I can skip reviews?

No. Manifest V3 forbids remotely hosted code, and extshare refuses packages that try. Your extension can still fetch data and configuration from your servers.

## Why is my build stuck in review?

The Chrome Web Store reviews most new versions. It usually takes hours, sometimes a few days, and longer for sensitive permissions or broad host access. extshare shows the state it reads from the store; the Developer Dashboard has more detail.

## Do I need a separate Web Store item for each test?

No, and you should not create one. One project is one item. Each publish uploads a new version of that item, so testers keep the same extension ID and get updates automatically.

## Can I host extshare on a serverless platform?

The server needs a persistent disk for its database and packages, and a long-running process for status checks, so use a VPS or a container host with a volume. This documentation site is static and can be hosted anywhere.

## How large can a package be?

64 MB compressed, 256 MB uncompressed, 5,000 files.

## Does extshare call Google when I run its tests?

No. The test suite uses in-memory fakes for the Web Store and Google, and never writes to a real database.
