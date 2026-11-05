/**
 * Static site generator for the extshare website: landing page + docs.
 * `bun run build:web` writes dist/web, which Vercel serves (see vercel.json).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
export const DEFAULT_OUT = join(ROOT, "dist/web");

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
