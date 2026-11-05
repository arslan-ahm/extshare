import { VERSION } from "@extshare/cli/src/main";
import type { Doc } from "./build";
import { GITHUB_URL, type Page } from "./layout";

// Real output formats, trimmed for space: the installer (static/install.sh) and `extshare publish` (packages/cli/src/commands.ts).
const PUBLISH = `<span class="prompt">$</span> curl -fsSL https://extshare.vercel.app/install.sh | sh
<span class="dim">Installed extshare ${VERSION}: /home/you/.extshare/bin/extshare</span>

<span class="prompt">$</span> extshare publish ./dist --ttl 7d \\
    --testers dana@example.com,lee@example.com
<span class="dim">Uploading Tab Notes 1.4.0 (182.4 KB)...</span>
Version   1.4.0
Testers   dana@example.com, lee@example.com

Share link (shown once, valid until 2026-11-12 14:05 UTC):
  <span class="hl">https://extshare.example.com/r/q3Vt9xK2...</span>

<span class="dim">The Web Store is reviewing this version. Testers see
the install button once it is live.</span>`;

const SERVER = `<span class="prompt">$</span> curl -fsSL https://extshare.vercel.app/install.sh | sh -s -- server
<span class="prompt">$</span> cd ~/extshare        <span class="dim"># your .env lives here</span>
<span class="prompt">$</span> extshare-server`;

export function landingPage(_docs: Doc[]): Page {
  return {
    path: "index.html",
    title: "extshare: share Chrome extension test builds",
    description:
      "Publish Chrome extension test builds from the command line, let only the Google accounts you name install them, and close access when testing ends.",
    section: "home",
    body: `
<section class="hero">
  <h1>Share your Chrome extension with testers before launch.</h1>
  <div class="hero-copy">
    <p class="lede">Publish a test build from your terminal. Only the Google accounts you name can install it, and access ends on schedule.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="/docs/getting-started">Get started</a>
      <a class="btn" href="${GITHUB_URL}" rel="noopener noreferrer">View source</a>
    </div>
  </div>
  <figure class="terminal">
    <pre aria-label="Example: publishing a test build"><code>${PUBLISH}</code></pre>
    <figcaption>Install the CLI once. Then one command uploads a build and prints a share link. Output trimmed.</figcaption>
  </figure>
</section>

<section class="compare" aria-labelledby="compare-title">
  <h2 id="compare-title">Sending a test build usually means sending a zip file.</h2>
  <div class="compare-grid">
    <div class="compare-col compare-old">
      <h3>The usual way</h3>
      <ul>
        <li>You post a .zip in chat or email.</li>
        <li>Testers turn on developer mode and load it unpacked.</li>
        <li>Every fix means building and sending a new zip.</li>
        <li>Once it is out, you cannot take it back.</li>
      </ul>
    </div>
    <div class="compare-col compare-new">
      <h3>With extshare</h3>
      <ul>
        <li>One command uploads the build to your own Web Store item.</li>
        <li>Testers sign in with Google and install from the store.</li>
        <li>New versions arrive as normal Chrome updates.</li>
        <li>Links expire on schedule, and you can revoke them any time.</li>
      </ul>
    </div>
  </div>
</section>

<section class="round" aria-labelledby="round-title">
  <h2 id="round-title">One test round, start to finish</h2>
  <ol class="track">
    <li>
      <span class="stop" aria-hidden="true"></span>
      <p class="who">You</p>
      <h3>Publish</h3>
      <p>The CLI packages and checks your build. The server checks it again and uploads it to your Web Store item.</p>
    </li>
    <li>
      <span class="stop" aria-hidden="true"></span>
      <p class="who">Chrome Web Store</p>
      <h3>Review</h3>
      <p>Usually a few hours, sometimes days. extshare follows the status and marks the release live when it passes.</p>
    </li>
    <li class="in-window">
      <span class="stop" aria-hidden="true"></span>
      <p class="who">Your testers</p>
      <h3>Install</h3>
      <p>They open your link and sign in with Google. Accounts on your list get the store's install button.</p>
    </li>
    <li class="in-window">
      <span class="stop" aria-hidden="true"></span>
      <p class="who">Automatic</p>
      <h3>Close</h3>
      <p>When the window ends or you revoke, every link stops working. An optional kill switch pushes an inert update to installed copies.</p>
    </li>
  </ol>
  <p class="window-note"><span class="window-bar" aria-hidden="true"></span><span>The test window runs from 15 minutes to 90 days. Set it with <code>--ttl</code>.</span></p>
</section>

<section class="security" aria-labelledby="security-title">
  <h2 id="security-title">Locked down by default</h2>
  <div class="bento">
    <article class="tile tile-wide tile-accent">
      <h3>Share links</h3>
      <p>Random 256-bit tokens, stored only as hashes and shown once. Each link checks the tester against your allowlist and never leaks through the Referer header.</p>
    </article>
    <article class="tile">
      <h3>Publisher accounts</h3>
      <p>Two-factor sign-in is required. CLI logins are approved in the browser.</p>
    </article>
    <article class="tile">
      <h3>Packages</h3>
      <p>Checked for unsafe ZIP tricks, Manifest V3 rules, leaked keys and remote code.</p>
    </article>
    <article class="tile tile-wide tile-ink">
      <h3>Audit trail</h3>
      <p>Every publish, link visit and revocation is written to an append-only log. Store credentials never leave your server.</p>
      <a href="/docs/security">Read the security model</a>
    </article>
  </div>
</section>

<section class="rules" aria-labelledby="rules-title">
  <div class="rules-intro">
    <h2 id="rules-title">Built around how Chrome installs extensions</h2>
    <p>Chrome only installs from the Web Store or through enterprise policy. extshare works inside those rules, so installs are real and nothing breaks at review time.</p>
  </div>
  <div class="rules-list">
    <details>
      <summary>Can a link install the extension without the Web Store?</summary>
      <p>No. The link checks who the tester is, then sends them to the store's own install button.</p>
    </details>
    <details>
      <summary>Do I need a new store item for every test?</summary>
      <p>No. One project is one item. Testers keep the same extension ID and get each new version as an update.</p>
    </details>
    <details>
      <summary>What happens if a tester forwards the link?</summary>
      <p>The extshare link only works for accounts on your list. Use a private item to make Chrome enforce that too: an unlisted item installs for anyone who has its store address.</p>
    </details>
    <details>
      <summary>Can my extension load its code from my server?</summary>
      <p>No. Manifest V3 forbids remote code, and extshare refuses packages that try before they reach review.</p>
    </details>
    <a class="rules-more" href="/docs/faq">More answers in the FAQ</a>
  </div>
</section>

<section class="selfhost" aria-labelledby="selfhost-title">
  <div>
    <h2 id="selfhost-title">Runs on your own server</h2>
    <p>One command with SQLite and a data folder, on any Linux or macOS server, or in Docker. Your Web Store credentials and your testers' data stay with you.</p>
    <a class="btn btn-primary" href="/docs/server">Read the server guide</a>
  </div>
  <pre aria-label="Installing and starting the server"><code>${SERVER}</code></pre>
</section>
`,
  };
}
