import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import type { Deps } from "../context";

export function clientIp(c: Context, deps: Deps): string | null {
  if (deps.config.trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim().slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export function secureCookies(deps: Deps): boolean {
  return deps.config.publicUrl.startsWith("https://");
}

/** `__Host-` cookies are locked to this origin and path, but browsers require Secure for them. */
export function cookieName(deps: Deps, base: string): string {
  return secureCookies(deps) ? `__Host-${base}` : base;
}

/** Only same-site relative paths are accepted as post-login redirects. */
export function safeNext(next: string | undefined | null, fallback = "/"): string {
  // Browsers drop tab/CR/LF inside URLs and treat "\" as "/", so "/\t/evil.test" would become "//evil.test".
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  if (!next?.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next) || next.startsWith("//"))
    return fallback;
  return next;
}

/** Rejects cross-origin form posts. Browsers always send Origin on POST from a page. */
export function sameOrigin(c: Context, deps: Deps): boolean {
  const origin = c.req.header("origin");
  if (!origin) return false;
  return origin === new URL(deps.config.publicUrl).origin;
}
