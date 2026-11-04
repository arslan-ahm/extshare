import { describe, expect, test } from "bun:test";
import {
  base32Decode,
  base32Encode,
  hashToken,
  newUserCode,
  normalizeUserCode,
  otpauthUri,
  RateLimiter,
  Signer,
  TOTP_STEP_MS,
  totpAt,
  verifyTotp,
} from "../src/security";

const enc = new TextEncoder();

describe("base32 (RFC 4648 test vectors)", () => {
  const vectors: [string, string][] = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];
  for (const [plain, b32] of vectors) {
    test(`"${plain}" <-> ${b32}`, () => {
      expect(base32Encode(enc.encode(plain))).toBe(b32);
      expect(new TextDecoder().decode(base32Decode(b32))).toBe(plain);
    });
  }
  test("decode is case- and padding-insensitive, rejects junk", () => {
    expect(new TextDecoder().decode(base32Decode("mzxw6ytboi======"))).toBe("foobar");
    expect(() => base32Decode("MZ1W")).toThrow();
  });
});

describe("TOTP (RFC 6238 Appendix B, SHA-1)", () => {
  const secret = enc.encode("12345678901234567890");
  // RFC values are 8 digits; authenticator apps use the last 6.
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, code8] of vectors) {
    test(`T=${t}`, () => {
      const step = Math.floor(t / 30);
      expect(totpAt(secret, step, 8)).toBe(code8);
      expect(totpAt(secret, step)).toBe(code8.slice(2));
    });
  }

  const b32 = base32Encode(secret);
  const now = 1234567890 * 1000;
  const step = Math.floor(now / TOTP_STEP_MS);
  test("accepts the current and adjacent steps, returns the matched step", () => {
    expect(verifyTotp(b32, totpAt(secret, step), now, 0)).toBe(step);
    expect(verifyTotp(b32, totpAt(secret, step - 1), now, 0)).toBe(step - 1);
    expect(verifyTotp(b32, totpAt(secret, step + 1), now, 0)).toBe(step + 1);
  });
  test("rejects codes two steps away", () => {
    expect(verifyTotp(b32, totpAt(secret, step - 2), now, 0)).toBeNull();
    expect(verifyTotp(b32, totpAt(secret, step + 2), now, 0)).toBeNull();
  });
  test("refuses replay of an already-used step", () => {
    const code = totpAt(secret, step);
    expect(verifyTotp(b32, code, now, step)).toBeNull();
    expect(verifyTotp(b32, code, now, step - 1)).toBe(step);
  });
  test("rejects malformed codes", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 345"])
      expect(verifyTotp(b32, bad, now, 0)).toBeNull();
  });
  test("otpauth URI carries secret and issuer", () => {
    const u = new URL(otpauthUri("ABC", "a@b.com", "extshare"));
    expect(u.protocol).toBe("otpauth:");
    expect(u.searchParams.get("secret")).toBe("ABC");
    expect(u.searchParams.get("issuer")).toBe("extshare");
  });
});

describe("Signer", () => {
  const s = new Signer("x".repeat(40));
  test("round-trips before expiry", () => {
    const v = s.sign("p", { a: 1 }, 2000);
    expect(s.verify("p", v, 1999)).toEqual({ a: 1 });
  });
  test("rejects expired, wrong purpose, tampered and garbage", () => {
    const v = s.sign("p", { a: 1 }, 2000);
    expect(s.verify("p", v, 2000)).toBeNull();
    expect(s.verify("q", v, 1000)).toBeNull();
    const [data, mac] = v.split(".");
    const forged = Buffer.from(JSON.stringify({ v: { a: 2 }, exp: 2000 })).toString("base64url");
    expect(s.verify("p", `${forged}.${mac}`, 1000)).toBeNull();
    expect(s.verify("p", `${data}.${mac!.slice(0, -2)}AA`, 1000)).toBeNull();
    expect(s.verify("p", "nodot", 1000)).toBeNull();
    expect(s.verify("p", undefined, 1000)).toBeNull();
  });
  test("a different secret cannot verify", () => {
    expect(new Signer("y".repeat(40)).verify("p", s.sign("p", 1, 2000), 1)).toBeNull();
  });
  test("refuses short secrets", () => {
    expect(() => new Signer("short")).toThrow();
  });
});

describe("misc", () => {
  test("hashToken is stable hex SHA-256", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  test("user codes use the unambiguous alphabet and normalise", () => {
    for (let i = 0; i < 200; i++)
      expect(newUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
    expect(normalizeUserCode(" bcdf ghjk ")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
  });
  test("rate limiter allows `limit` per window then resets", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 3; i++) expect(rl.take("k", 3, 1000)).toBe(true);
    expect(rl.take("k", 3, 1000)).toBe(false);
    expect(rl.take("other", 3, 1000)).toBe(true);
    t = 1000;
    expect(rl.take("k", 3, 1000)).toBe(true);
  });
});
