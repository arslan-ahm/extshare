import type { Doc } from "./build";
import { GITHUB_URL, type Page } from "./layout";

const USAGE = `# once per machine
extshare login --server https://extshare.example.com

# from your extension's folder
extshare publish ./dist --ttl 7d \\
  --testers alice@example.com,bob@example.com

# when the test is over
extshare revoke &lt;release&gt; --reason "shipped"`;

export function landingPage(_docs: Doc[]): Page {
  return {
    path: "index.html",
    title: "extshare: share Chrome extension test builds",
    description:
      "Publish Chrome extension test builds from the command line, let only the Google accounts you name install them, and close access when testing ends.",
    section: "home",
    body: `
<section class="hero">
  <div class="hero-copy">
    <h1>Test builds, shared with a link that expires.</h1>
    <p class="lede">Publish Chrome extension builds from your terminal. Only accounts you name can install, and access closes when testing ends.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="/docs/getting-started">Get started</a>
      <a class="btn" href="${GITHUB_URL}" rel="noopener noreferrer">View on GitHub</a>
    </div>
  </div>
  <figure class="hero-code">
    <pre aria-label="Example CLI usage"><code>${USAGE}</code></pre>
    <figcaption>Three commands cover a whole test round.</figcaption>
  </figure>
</section>

<section class="flow" aria-labelledby="flow-title">
  <h2 id="flow-title">From your build folder to a tester's Chrome</h2>
  <ol class="flow-list">
    <li>
      <h3>Publish</h3>
      <p>The CLI packages your build and checks it. The server checks it again, then uploads it to your Chrome Web Store item.</p>
    </li>
    <li>
      <h3>Review</h3>
      <p>The Web Store reviews the version. extshare follows its status and marks the release live when it is approved.</p>
    </li>
    <li>
      <h3>Share</h3>
      <p>Testers open your link and sign in with Google. Listed accounts get the store's install button and automatic updates.</p>
    </li>
    <li>
      <h3>Close</h3>
      <p>When the window ends or you revoke, every link stops working. A kill switch can push an inert update to installed copies.</p>
    </li>
  </ol>
</section>

<section class="honest">
  <div class="honest-intro">
    <h2>Built around how Chrome installs extensions</h2>
    <p>Chrome only installs from the Chrome Web Store or enterprise policy. extshare works inside those rules instead of around them, so installs are real and nothing breaks at review time.</p>
    <a href="/docs#what-chrome-decides">Read what Chrome decides</a>
  </div>
  <ul class="honest-list">
    <li><strong>Installs come from the Web Store.</strong> Your link checks who the tester is, then hands them the store's own install button.</li>
    <li><strong>One project, one store item.</strong> Testers keep the same extension ID and get each new version as an update.</li>
    <li><strong>Private items stay private.</strong> Only accounts on the item's trusted-tester list can install, even if a link is forwarded.</li>
    <li><strong>No remote code.</strong> Packages that load scripts from the network are refused before they reach review.</li>
  </ul>
</section>

<section class="security" aria-labelledby="security-title">
  <h2 id="security-title">Locked down by default</h2>
  <div class="security-grid">
    <div class="security-item">
      <h3>Publisher accounts</h3>
      <p>Mandatory two-factor sign-in, browser-approved CLI logins, and refresh tokens that revoke themselves if copied.</p>
    </div>
    <div class="security-item">
      <h3>Packages</h3>
      <p>Checked for unsafe ZIP tricks, Manifest V3 rules, leaked keys and remote code. Every byte is hashed and verified end to end.</p>
    </div>
    <div class="security-item">
      <h3>Share links</h3>
      <p>Random 256-bit tokens stored only as hashes, shown once, tied to an allowlist, and never leaked through the Referer header.</p>
    </div>
    <div class="security-item">
      <h3>Credentials and audit</h3>
      <p>Store credentials never leave your server. Every publish, link visit and revocation lands in an append-only log.</p>
    </div>
  </div>
  <p class="more"><a href="/docs/security">Read the security model</a></p>
</section>

<section class="selfhost">
  <div>
    <h2>Runs on your own server</h2>
    <p>One Bun process with SQLite and a data folder. Your Web Store credentials and your testers' data stay with you.</p>
    <a class="btn btn-primary" href="/docs/server">Read the server guide</a>
  </div>
  <pre aria-label="Docker example"><code>docker build -t extshare .
docker run -d --env-file .env \\
  -v extshare-data:/data \\
  -p 127.0.0.1:8787:8787 extshare</code></pre>
</section>
`,
  };
}
