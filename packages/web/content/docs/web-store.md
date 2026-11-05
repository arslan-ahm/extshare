---
title: Chrome Web Store setup
order: 3
description: Create the Web Store item, choose its visibility, manage trusted testers, and give the server publishing credentials.
---

# Chrome Web Store setup

extshare publishes through the Chrome Web Store API (v2). The API uploads and submits new versions of an item that already exists; it cannot create items, change visibility, or edit trusted testers. Those stay in the Developer Dashboard.

## Create the item

1. Open the [Developer Dashboard](https://chrome.google.com/webstore/devconsole/). Google requires 2-step verification on the publisher account.
2. Upload a first build by hand to create the item. Its ID is the 32 letters (a to p) in the item's URL.
3. Complete the **Store listing** and **Privacy** tabs. The store will not accept a submission without them.
4. Under **Distribution**, set visibility and publish once by hand. If you change visibility later in the dashboard, publish once by hand again before extshare can publish through the API.

## Private or Unlisted

|                          | Private                                                                                     | Unlisted                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Who can install          | Google accounts on the item's trusted-tester list, a Google Group, or your Workspace domain | Anyone with the store URL                                                                   |
| What the share link adds | Sign-in and an allowlist check before showing the store URL                                 | The same, but someone who has the store URL can forward it                                  |
| Tester list in extshare  | Required (at least one)                                                                     | Optional. With no list, any signed-in Google account holding the share link sees the button |

For private items, keep the trusted-tester list in the Developer Dashboard in step with the testers you add in extshare. The easiest way is to add one Google Group to the item as trusted testers, then manage people in Google Groups.

## Publishing credentials

The server needs `CWS_PUBLISHER_ID` (shown under **Publisher > Settings** in the Developer Dashboard) and one of these:

### Service account (recommended)

1. In Google Cloud, enable the **Chrome Web Store API** and create a service account.
2. Create a JSON key for it and copy it to the server.
3. In the Developer Dashboard, open **Account** and add the service account's email. A publisher can link one service account.
4. Set `CWS_SERVICE_ACCOUNT_FILE` to the key file's path.

### OAuth refresh token

1. In Google Cloud, enable the **Chrome Web Store API** and create an OAuth client of type **Web application** with `https://developers.google.com/oauthplayground` as an authorized redirect URI.
2. In the [OAuth Playground](https://developers.google.com/oauthplayground), use your own client credentials, authorize the scope `https://www.googleapis.com/auth/chromewebstore` with the publisher account, and exchange the code for tokens.
3. Set `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` and `CWS_REFRESH_TOKEN`.

The credentials stay on the server. The CLI never receives them.
