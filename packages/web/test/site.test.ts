import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { HELP } from "@extshare/cli/src/main";
import {
  BUNDLES,
  build,
  DOWNLOAD_FILES,
  FONT_FILES,
  loadDocs,
  PRODUCTION_URL,
  renderDoc,
  STATIC_FILES,
} from "../src/build";
import { createPreview } from "../src/preview";

// The build bundles the CLI and the server, which takes a few seconds.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "../../..");
let out: string;
let files: string[];
let preview: (r: Request) => Response;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? walk(full) : [relative(out, full).split(sep).join("/")];
  });
}
const html = (rel: string) => readFileSync(join(out, rel), "utf8");
const get = (path: string) => preview(new Request(`https://site.test${path}`));

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "extshare-web-"));
  build(out, "https://site.test");
  files = walk(out);
  preview = createPreview(out);
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("site build", () => {
  test("produces the landing page, one page per doc, 404, assets and SEO files", () => {
    const docs = loadDocs();
    expect(docs.length).toBeGreaterThanOrEqual(9);
    const expected = [
      "index.html",
      "404.html",
      "assets/site.css",
      ...FONT_FILES.map((f) => `assets/fonts/${f}`),
      ...STATIC_FILES,
      ...DOWNLOAD_FILES.map((f) => `download/${f}`),
      "favicon.svg",
      "robots.txt",
      "sitemap.xml",
      ...docs.map((d) => (d.slug ? `docs/${d.slug}.html` : "docs/index.html")),
    ];
    expect(files.sort()).toEqual(expected.sort());
  });

  test("docs are ordered by front matter and every order is unique", () => {
    const orders = loadDocs().map((d) => d.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  test("the CLI reference embeds the CLI's real help text", () => {
    const page = html("docs/cli.html");
    expect(page).not.toContain("{{CLI_HELP}}");
    for (const line of HELP.trim()
      .split("\n")
      .filter((l) => l.trim())) {
      expect(page).toContain(
        line
          .trim()
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;"),
      );
    }
  });

  test("every HTML page has a title, description, language, viewport and no scripts", () => {
    for (const f of files.filter((f) => f.endsWith(".html"))) {
      const h = html(f);
      expect(h).toMatch(/<html lang="en">/);
      expect(h).toMatch(/<title>[^<]{3,}<\/title>/);
      expect(h).toMatch(/<meta name="description" content="[^"]{20,}">/);
      expect(h).toContain('name="viewport"');
      expect(h).not.toMatch(/<script/i);
      expect(h).not.toMatch(/\sstyle="/i); // CSP allows only the external stylesheet
      expect(h).not.toMatch(/\son[a-z]+="/i);
    }
  });

  test("no em or en dashes anywhere on the site", () => {
    for (const f of files.filter((f) => f.endsWith(".html"))) {
      const bad = html(f).match(/.{0,30}[–—].{0,30}/);
      expect(bad?.[0] ?? null).toBeNull();
    }
  });

  test("every internal link and anchor resolves to a built page", () => {
    const broken: string[] = [];
    const ids = new Map<string, Set<string>>();
    const pagePathOf = (f: string) => (f === "index.html" ? "/" : `/${f.replace(/(\/index)?\.html$/, "")}`);
    for (const f of files.filter((f) => f.endsWith(".html"))) {
      ids.set(pagePathOf(f), new Set([...html(f).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!)));
    }
    for (const f of files.filter((f) => f.endsWith(".html"))) {
      for (const [, href] of html(f).matchAll(/\s(?:href|src)="([^"]+)"/g)) {
        if (/^(https?:|mailto:)/.test(href!)) continue;
        const [path, hash] = href!.split("#");
        const target = path === "" ? pagePathOf(f) : path!;
        const res = get(target);
        if (res.status !== 200) broken.push(`${f}: ${href} -> ${res.status}`);
        else if (hash && !ids.get(target)?.has(hash)) broken.push(`${f}: ${href} -> missing #${hash}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("sitemap lists the absolute URL of every page", () => {
    const sm = html("sitemap.xml");
    expect(sm).toContain("<loc>https://site.test</loc>");
    for (const d of loadDocs())
      expect(sm).toContain(`<loc>https://site.test${d.slug ? `/docs/${d.slug}` : "/docs"}</loc>`);
    expect(html("robots.txt")).toContain("Sitemap: https://site.test/sitemap.xml");
  });

  test("without a site URL the build omits the sitemap instead of writing relative URLs", () => {
    const dir = mkdtempSync(join(tmpdir(), "extshare-web-nourl-"));
    try {
      const r = build(dir, undefined);
      expect(r.files).not.toContain("sitemap.xml");
      expect(readFileSync(join(dir, "robots.txt"), "utf8")).not.toContain("Sitemap");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("markdown rendering", () => {
  test("headings get unique ids, external links get rel, tables are wrapped", () => {
    const d = renderDoc(
      "x.md",
      "---\ntitle: T\norder: 1\ndescription: d\n---\n# T\n## Same\n## Same\n[ext](https://e.test) [int](/docs)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
    );
    expect(d.headings.map((h) => h.id)).toEqual(["same", "same-x"]);
    expect(d.html).toContain('<a href="https://e.test" rel="noopener noreferrer">ext</a>');
    expect(d.html).toContain('<a href="/docs">int</a>');
    expect(d.html).toContain('<div class="table-wrap"><table>');
  });
  test("front matter is required", () => {
    expect(() => renderDoc("x.md", "# no front matter")).toThrow(/front matter/);
    expect(() => renderDoc("x.md", "---\ntitle: T\n---\n# T")).toThrow(/order/);
  });
});

describe("preview server mirrors Vercel", () => {
  test("clean URLs, redirects from .html, 404 page, headers from vercel.json", async () => {
    expect(get("/").status).toBe(200);
    expect(get("/docs").status).toBe(200);
    expect(get("/docs/cli").status).toBe(200);
    const redirect = get("/docs/cli.html");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/docs/cli");
    expect(get("/docs/index.html").headers.get("location")).toBe("/docs");
    const missing = get("/nope");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Page not found");
    expect(get("/../../etc/passwd").status).toBe(404);
    const h = get("/docs").headers;
    expect(h.get("content-security-policy")).toContain("default-src 'none'");
    expect(h.get("content-type")).toContain("text/html");
    expect(get("/assets/site.css").headers.get("cache-control")).toBe("public, max-age=3600");
    expect(h.get("content-security-policy")).toContain("font-src 'self'");
    const font = get("/assets/fonts/Geist-Variable.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toContain("font/woff2");
  });

  test("every url() in the stylesheet and every preload points at a built file", () => {
    const css = html("assets/site.css");
    const refs = [
      ...css.matchAll(/url\("([^"]+)"\)/g),
      ...html("index.html").matchAll(/rel="preload" href="([^"]+)"/g),
    ].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const r of refs) expect(get(r).status).toBe(200);
  });

  test("installers are served as plain text with a short cache", async () => {
    for (const path of ["/install.sh", "/install.ps1"]) {
      const r = get(path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(r.headers.get("cache-control")).toBe("public, max-age=300");
      expect(await r.text()).toBe(readFileSync(join(import.meta.dir, "../static", path.slice(1)), "utf8"));
    }
  });
});

describe("downloads published with the site", () => {
  const sh = readFileSync(join(import.meta.dir, "../static/install.sh"), "utf8");
  const ps1 = readFileSync(join(import.meta.dir, "../static/install.ps1"), "utf8");
  const sha = (b: ArrayBuffer) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

  test("every download is served with a short cache, and SHA256SUMS matches what is served", async () => {
    for (const f of DOWNLOAD_FILES) {
      const r = get(`/download/${f}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    }
    const sums = await get("/download/SHA256SUMS").text();
    const bundles = Object.keys(BUNDLES);
    expect(sums.trim().split("\n")).toHaveLength(bundles.length);
    for (const f of bundles) {
      expect(sums).toContain(`${sha(await get(`/download/${f}`).arrayBuffer())}  ${f}`);
    }
  });

  test("the published Dockerfile pins the served server bundle by checksum", async () => {
    const dockerfile = await get("/download/Dockerfile").text();
    const server = sha(await get("/download/extshare-server.js").arrayBuffer());
    expect(dockerfile).toContain(
      `ADD --checksum=sha256:${server} https://site.test/download/extshare-server.js /app/extshare-server.js`,
    );
    expect(dockerfile).toContain('ENTRYPOINT ["extshare-server"]');
  });

  test("installers download from the production site and ask only for published files", () => {
    expect(sh).toContain(`base="\${EXTSHARE_DOWNLOAD_BASE:-${PRODUCTION_URL}/download}"`);
    expect(ps1).toContain(`'${PRODUCTION_URL}/download'`);
    // Both scripts fetch "<tool>.js" for tool extshare (cli) or extshare-server (server), plus SHA256SUMS.
    expect(sh).toContain('file="$tool.js"');
    expect(ps1).toContain('$file = "$tool.js"');
    for (const tool of ["extshare", "extshare-server"]) {
      expect(sh).toContain(`tool=${tool}`);
      expect(ps1).toContain(`$tool = '${tool}'`);
      expect(Object.keys(BUNDLES)).toContain(`${tool}.js`);
    }
  });

  test(".env.example never overrides the Docker images' listen address or data volume", async () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const active = example
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.split("=")[0]);
    expect(active).toContain("PUBLIC_URL"); // precondition: the parse found the real settings
    expect(active).not.toContain("HOST");
    expect(active).not.toContain("DATA_DIR");
    for (const dockerfile of [
      readFileSync(join(ROOT, "Dockerfile"), "utf8"),
      await get("/download/Dockerfile").text(),
    ]) {
      expect(dockerfile).toContain("ENV DATA_DIR=/data HOST=0.0.0.0 PORT=8787");
      expect(dockerfile).toContain('VOLUME ["/data"]');
      expect(dockerfile).toContain('ENTRYPOINT ["extshare-server"]');
    }
  });

  test("docs install the tools instead of cloning the repository", () => {
    const docs = loadDocs();
    const all = docs.map((d) => d.html).join("\n");
    expect(all).toContain("https://extshare.vercel.app/install.sh");
    expect(all).toContain("https://extshare.vercel.app/install.ps1");
    expect(all).toContain("https://extshare.vercel.app/download/Dockerfile");
    expect(all).not.toContain("ghcr.io");
    expect(all).not.toContain("releases/latest");
    for (const d of docs) {
      // Only the server guide may mention a source checkout, and only in its "Run from source" section.
      const clone = d.html.indexOf("git clone");
      if (clone === -1) continue;
      expect(d.slug).toBe("server");
      expect(clone).toBeGreaterThan(d.html.indexOf('id="run-from-source"'));
    }
    const home = html("index.html");
    expect(home).toContain("curl -fsSL https://extshare.vercel.app/install.sh | sh");
    expect(home).toContain("install.sh | sh -s -- server");
  });
});

describe("vercel.json", () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  test("build command and output directory match the repository", () => {
    expect(cfg.buildCommand).toBe("bun run build:web");
    expect(pkg.scripts["build:web"]).toBe("bun run packages/web/src/build.ts");
    expect(cfg.outputDirectory).toBe("dist/web");
    expect(cfg.installCommand).toContain("bun install");
    expect(cfg.cleanUrls).toBe(true);
  });
  test("the CSP allows everything the pages load and nothing more", () => {
    const csp: string = cfg.headers[0].headers.find(
      (h: { key: string }) => h.key === "Content-Security-Policy",
    ).value;
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("default-src 'none'");
  });
});
