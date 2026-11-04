import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/** Bearer tokens, session IDs and invite tokens are stored only as this hash. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** HMAC-signed, expiring value: `<base64url payload>.<base64url mac>`. Used for cookies and download URLs. */
export class Signer {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error("SECRET must be at least 32 bytes");
  }

  private mac(purpose: string, data: string): string {
    return createHmac("sha256", this.secret).update(`${purpose}\n${data}`).digest("base64url");
  }

  sign(purpose: string, value: unknown, expiresAt: number): string {
    const data = Buffer.from(JSON.stringify({ v: value, exp: expiresAt })).toString("base64url");
    return `${data}.${this.mac(purpose, data)}`;
  }

  verify<T>(purpose: string, signed: string | undefined, now: number): T | null {
    if (!signed) return null;
    const dot = signed.indexOf(".");
    if (dot <= 0) return null;
    const data = signed.slice(0, dot);
    if (!safeEqual(signed.slice(dot + 1), this.mac(purpose, data))) return null;
    try {
      const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as { v: T; exp: number };
      return typeof parsed.exp === "number" && parsed.exp > now ? parsed.v : null;
    } catch {
      return null;
    }
  }
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export const TOTP_STEP_MS = 30_000;

/** RFC 6238 TOTP with HMAC-SHA1 (the variant authenticator apps implement). */
export function totpAt(secret: Uint8Array, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secret).update(counter).digest();
  const offset = h[h.length - 1]! & 0xf;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * Returns the matched time-step for a code within ±1 step of now, or null. Steps at or before
 * `lastStep` are refused so a code that was already accepted cannot be replayed.
 */
export function verifyTotp(secretB32: string, code: string, now: number, lastStep: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const current = Math.floor(now / TOTP_STEP_MS);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastStep) continue;
    if (safeEqual(totpAt(secret, step), code)) return step;
  }
  return null;
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Fixed-window limiter keyed by e.g. "login:<ip>". In-process; run one server instance or front it with a shared limiter. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number) {}

  /** Returns true when the action is allowed. */
  take(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + windowMs });
      if (this.hits.size > 50_000) this.sweep(t);
      return true;
    }
    cur.count++;
    return cur.count <= limit;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

/** Human-typable device code: 8 characters from an alphabet without look-alikes, shown as XXXX-XXXX. */
export function newUserCode(): string {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789";
  // Rejection sampling keeps every character equally likely (256 is not a multiple of 28).
  const limit = 256 - (256 % alphabet.length);
  let s = "";
  while (s.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte < limit && s.length < 8) s += alphabet[byte % alphabet.length];
    }
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function normalizeUserCode(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}
