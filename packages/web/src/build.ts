/**
 * Static site generator for the extshare website: landing page + docs.
 * `bun run build:web` writes dist/web, which Vercel serves (see vercel.json).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HELP } from "@extshare/cli/src/main";
import { Marked, type Tokens } from "marked";
import { landingPage } from "./landing";
import { esc, GITHUB_URL, type Page, page } from "./layout";
import CSS from "./site.css" with { type: "text" };

const ROOT = join(import.meta.dir, "../../..");
const CONTENT = join(import.meta.dir, "../content/docs");
/** Self-hosted Geist fonts (SIL OFL); the licence ships next to them. */
const FONTS = join(import.meta.dir, "fonts");
export const FONT_FILES = ["Geist-Variable.woff2", "GeistMono-Variable.woff2", "OFL.txt"];
/** CLI installers, served from the site root (https://<site>/install.sh, /install.ps1). */
const STATIC = join(import.meta.dir, "../static");
export const STATIC_FILES = ["install.sh", "install.ps1"];
export const DEFAULT_OUT = join(ROOT, "dist/web");
/** Where the installers download from; tests and previews pass their own site URL. */
export const PRODUCTION_URL = "https://extshare.vercel.app";

/**
 * The installable tools, published with every deploy under /download:
 *   extshare.js         the CLI, bundled into one file for the Bun runtime
 *   extshare-server.js  the server (and `admin` subcommand), likewise
 *   SHA256SUMS          checksums the installers verify before installing
 *   VERSION             the release version (packages/cli and packages/server must agree)
 *   Dockerfile          builds a server image from the published bundle, pinned by checksum
 */
export const BUNDLES = {
  "extshare.js": "packages/cli/src/main.ts",
  "extshare-server.js": "packages/server/src/bin.ts",
} as const;
export const DOWNLOAD_FILES = [...Object.keys(BUNDLES), "SHA256SUMS", "VERSION", "Dockerfile"];

export function releaseVersion(): string {
  const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8")).version as string;
  const cli = read("packages/cli/package.json");
  const server = read("packages/server/package.json");
  if (cli !== server) throw new Error(`Version mismatch: cli ${cli}, server ${server}`);
  return cli;
}

function bundle(entry: string): Uint8Array<ArrayBuffer> {
  const dir = mkdtempSync(join(tmpdir(), "extshare-bundle-"));
  try {
    const r = Bun.spawnSync(
      [process.execPath, "build", join(ROOT, entry), "--target", "bun", "--minify", "--outdir", dir],
      {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (r.exitCode !== 0) throw new Error(`bundling ${entry} failed:\n${r.stderr.toString()}`);
    const [out] = readdirSync(dir).filter((f) => f.endsWith(".js"));
    if (!out || readdirSync(dir).length !== 1)
      throw new Error(`bundling ${entry} did not produce exactly one file`);
    return new Uint8Array(readFileSync(join(dir, out)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function buildDownloads(siteUrl: string): [string, string | Uint8Array<ArrayBuffer>][] {
  const version = releaseVersion();
  const files: [string, Uint8Array<ArrayBuffer>][] = Object.entries(BUNDLES).map(([name, entry]) => [
    name,
    bundle(entry),
  ]);
  const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
  const sums = files.map(([name, b]) => `${sha(b)}  ${name}\n`).join("");
  const server = files.find(([n]) => n === "extshare-server.js")![1];
  const dockerfile = `# syntax=docker/dockerfile:1.7
# extshare server ${version}, built from the published bundle (checksum pinned).
#   docker build -t extshare ${siteUrl}/download/Dockerfile
FROM oven/bun:1.3-slim
WORKDIR /app
ADD --checksum=sha256:${sha(server)} ${siteUrl}/download/extshare-server.js /app/extshare-server.js
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=8787
RUN mkdir -p /data && chown bun:bun /data && chmod 644 /app/extshare-server.js \\
 && printf '#!/bin/sh\\nexec bun /app/extshare-server.js "$@"\\n' > /usr/local/bin/extshare-server \\
 && chmod 755 /usr/local/bin/extshare-server
USER bun
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["extshare-server"]
`;
  return [...files, ["SHA256SUMS", sums], ["VERSION", `${version}\n`], ["Dockerfile", dockerfile]];
}

export interface Doc {
  slug: string;
  title: string;
  description: string;
  order: number;
  html: string;
  headings: { id: string; text: string }[];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseFrontMatter(raw: string, file: string): { meta: Record<string, string>; body: string } {
  const m = raw.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const k of ["title", "order", "description"])
    if (!meta[k]) throw new Error(`${file}: front matter needs "${k}"`);
  return { meta, body: m[2]! };
}

export function renderDoc(file: string, raw: string): Doc {
  const { meta, body } = parseFrontMatter(raw, file);
  const headings: Doc["headings"] = [];
  const used = new Set<string>();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(
        this: { parser: { parseInline: (t: Tokens.Generic[]) => string } },
        { tokens, depth }: Tokens.Heading,
      ) {
        const inner = this.parser.parseInline(tokens);
        if (depth === 1) return `<h1>${inner}</h1>\n`;
        let id = slugify(inner) || "section";
        while (used.has(id)) id += "-x";
        used.add(id);
        if (depth === 2) headings.push({ id, text: inner.replace(/<[^>]+>/g, "") });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${depth}>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const text = (
          this as unknown as { parser: { parseInline: (t: Tokens.Generic[]) => string } }
        ).parser.parseInline(tokens);
        const external = /^https?:\/\//.test(href);
        const t = title ? ` title="${esc(title)}"` : "";
        return `<a href="${esc(href)}"${t}${external ? ' rel="noopener noreferrer"' : ""}>${text}</a>`;
      },
      table(this: unknown, token: Tokens.Table) {
        // Wrap tables so wide ones scroll inside the content column on phones instead of the page.
        const parser = (this as { parser: { parseInline: (t: Tokens.Generic[]) => string } }).parser;
        const cell = (c: Tokens.TableCell, tag: "th" | "td") =>
          `<${tag}>${parser.parseInline(c.tokens)}</${tag}>`;
        const head = `<tr>${token.header.map((c) => cell(c, "th")).join("")}</tr>`;
        const rows = token.rows.map((r) => `<tr>${r.map((c) => cell(c, "td")).join("")}</tr>`).join("");
        return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  const source = body.replace("{{CLI_HELP}}", HELP.trimEnd());
  const html = marked.parse(source, { async: false }) as string;
  const base = file.replace(/\.md$/, "");
  return {
    slug: base === "index" ? "" : base,
    title: meta.title!,
    description: meta.description!,
    order: Number(meta.order),
    html,
    headings,
  };
}

export function loadDocs(dir = CONTENT): Doc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => renderDoc(f, readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.order - b.order);
}

export const docHref = (d: Pick<Doc, "slug">) => (d.slug ? `/docs/${d.slug}` : "/docs");

function docPage(doc: Doc, docs: Doc[]): Page {
  const i = docs.indexOf(doc);
  const prev = docs[i - 1];
  const next = docs[i + 1];
  const nav = docs
    .map(
      (d) => `<li><a href="${docHref(d)}"${d === doc ? ' aria-current="page"' : ""}>${esc(d.title)}</a></li>`,
    )
    .join("");
  const toc =
    doc.headings.length > 1
      ? `<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${doc.headings
          .map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`)
          .join("")}</ul></nav>`
      : "";
  const pager = `<nav class="pager" aria-label="Previous and next">${
    prev
      ? `<a class="pager-prev" href="${docHref(prev)}"><span>Previous</span>${esc(prev.title)}</a>`
      : "<span></span>"
  }${next ? `<a class="pager-next" href="${docHref(next)}"><span>Next</span>${esc(next.title)}</a>` : ""}</nav>`;
  const edit = `${GITHUB_URL}/blob/main/packages/web/content/docs/${doc.slug || "index"}.md`;
  return {
    path: doc.slug ? `docs/${doc.slug}.html` : "docs/index.html",
    title: doc.title,
    description: doc.description,
    section: "docs",
    body: `<div class="docs">
  <details class="docs-nav-mobile"><summary>Documentation</summary><ul>${nav}</ul></details>
  <aside class="docs-nav" aria-label="Documentation"><ul>${nav}</ul></aside>
  <article class="prose">${doc.html}${pager}<p class="edit"><a href="${edit}" rel="noopener noreferrer">Edit this page on GitHub</a></p></article>
  ${toc}
</div>`,
  };
}

function notFoundPage(): Page {
  return {
    path: "404.html",
    title: "Page not found",
    description: "This page does not exist.",
    section: "none",
    body: `<section class="narrow"><h1>Page not found</h1><p class="lede">There is nothing at this address.</p><p><a class="btn btn-primary" href="/docs">Read the docs</a></p></section>`,
  };
}

export interface BuildResult {
  outDir: string;
  files: string[];
}

export function build(outDir = DEFAULT_OUT, siteUrl = process.env.SITE_URL ?? vercelUrl()): BuildResult {
  const docs = loadDocs();
  rmSync(outDir, { recursive: true, force: true });
  const files: string[] = [];
  const write = (rel: string, content: string | Uint8Array) => {
    const full = join(outDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    files.push(rel);
  };
  const pages: Page[] = [landingPage(docs), ...docs.map((d) => docPage(d, docs)), notFoundPage()];
  for (const p of pages) write(p.path, page(p));
  write("assets/site.css", CSS);
  for (const f of FONT_FILES) write(`assets/fonts/${f}`, readFileSync(join(FONTS, f)));
  for (const f of STATIC_FILES) write(f, readFileSync(join(STATIC, f)));
  for (const [rel, content] of buildDownloads(siteUrl ?? PRODUCTION_URL)) write(`download/${rel}`, content);
  write(
    "favicon.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2c4ecc"/><rect x="9" y="9" width="14" height="14" rx="3" fill="#fff"/></svg>\n',
  );
  const robots = siteUrl
    ? `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`
    : "User-agent: *\nAllow: /\n";
  write("robots.txt", robots);
  if (siteUrl) {
    const urls = ["/", ...docs.map(docHref)]
      .map((u) => `  <url><loc>${siteUrl}${u === "/" ? "" : u}</loc></url>`)
      .join("\n");
    write(
      "sitemap.xml",
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    );
  }
  return { outDir, files };
}

/** Vercel exposes the production domain to builds; used for absolute URLs in the sitemap. */
function vercelUrl(): string | undefined {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}` : undefined;
}

if (import.meta.main) {
  const r = build();
  console.log(`Built ${r.files.length} files into ${r.outDir}`);
}
