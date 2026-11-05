export const GITHUB_URL = "https://github.com/arslan-ahm/extshare";

export interface Page {
  /** Output path relative to the site root, e.g. "docs/cli.html". */
  path: string;
  title: string;
  description: string;
  section: "home" | "docs" | "none";
  body: string;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function page(p: Page): string {
  const title = p.section === "home" ? p.title : `${p.title} | extshare`;
  const current = (s: Page["section"]) => (p.section === s ? ' aria-current="page"' : "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(p.description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="site-header-inner">
    <a class="brand" href="/" aria-label="extshare home"><span class="brand-mark" aria-hidden="true"></span>extshare</a>
    <nav class="site-nav" aria-label="Main">
      <a href="/docs"${current("docs")}>Docs</a>
      <a href="/docs/cli">CLI</a>
      <a href="/docs/security">Security</a>
      <a href="${GITHUB_URL}" rel="noopener noreferrer">GitHub</a>
    </nav>
    <a class="btn btn-primary btn-sm header-cta" href="/docs/getting-started">Get started</a>
  </div>
</header>
<main id="main">
${p.body}
</main>
<footer class="site-footer">
  <div class="site-footer-inner">
    <div class="footer-about">
      <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>extshare</a>
      <p>Open source, self-hosted test releases for Chrome extensions.</p>
    </div>
    <nav aria-label="Footer">
      <a href="/docs/getting-started">Getting started</a>
      <a href="/docs/web-store">Web Store setup</a>
      <a href="/docs/testers">For testers</a>
      <a href="/docs/security">Security model</a>
      <a href="/docs/faq">FAQ</a>
      <a href="${GITHUB_URL}" rel="noopener noreferrer">Source on GitHub</a>
    </nav>
  </div>
</footer>
</body>
</html>
`;
}
