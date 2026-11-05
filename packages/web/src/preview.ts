/**
 * Local preview of dist/web that behaves like Vercel for this site: clean URLs (/docs/cli -> docs/cli.html,
 * /docs -> docs/index.html), 404.html for misses, and the headers declared in vercel.json.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { DEFAULT_OUT } from "./build";

interface VercelConfig {
  headers?: { source: string; headers: { key: string; value: string }[] }[];
}

const ROOT = join(import.meta.dir, "../../..");

export function resolvePath(outDir: string, urlPath: string): string | null {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/\\/g, "/");
  if (clean.includes("..")) return null;
  const rel = clean.replace(/^\/+/, "").replace(/\/+$/, "");
  const candidates = rel === "" ? ["index.html"] : [rel, `${rel}.html`, `${rel}/index.html`];
  for (const c of candidates) {
    const full = join(outDir, c);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

/** Converts a Vercel `source` pattern of the form used in vercel.json into a RegExp. */
function sourceToRegExp(source: string): RegExp {
  return new RegExp(`^${source.replace(/\(\.\*\)/g, "(.*)")}$`);
}

export function createPreview(
  outDir = DEFAULT_OUT,
  config: VercelConfig = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")),
) {
  const rules = (config.headers ?? []).map((h) => ({ re: sourceToRegExp(h.source), headers: h.headers }));
  return (req: Request): Response => {
    const url = new URL(req.url);
    // Vercel cleanUrls: requests for *.html redirect to the extensionless path.
    if (url.pathname.endsWith(".html")) {
      const target = url.pathname.replace(/(\/index)?\.html$/, "") || "/";
      return new Response(null, { status: 308, headers: { location: target } });
    }
    const file = resolvePath(outDir, url.pathname);
    const status = file ? 200 : 404;
    const path = file ?? join(outDir, "404.html");
    const headers = new Headers({ "content-type": Bun.file(path).type });
    for (const r of rules)
      if (r.re.test(url.pathname)) for (const h of r.headers) headers.set(h.key, h.value);
    return new Response(Bun.file(path), { status, headers });
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4321);
  Bun.serve({ hostname: "127.0.0.1", port, fetch: createPreview() });
  console.log(`Preview at http://127.0.0.1:${port}`);
}
