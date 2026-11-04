import type { Finding } from "./manifest";

interface SecretPattern {
  code: string;
  label: string;
  re: RegExp;
}

/** High-confidence credential formats. Kept narrow on purpose: every hit blocks the publish. */
export const SECRET_PATTERNS: SecretPattern[] = [
  {
    code: "secret_private_key",
    label: "private key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY( BLOCK)?-----/,
  },
  { code: "secret_aws_key", label: "AWS access key ID", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    code: "secret_github_token",
    label: "GitHub token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/,
  },
  { code: "secret_slack_token", label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { code: "secret_stripe_key", label: "Stripe secret key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  {
    code: "secret_google_oauth_secret",
    label: "Google OAuth client secret",
    re: /\bGOCSPX-[A-Za-z0-9_-]{28}\b/,
  },
  { code: "secret_google_refresh_token", label: "Google refresh token", re: /\b1\/\/0[A-Za-z0-9_-]{40,}\b/ },
  { code: "secret_openai_key", label: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/ },
  { code: "secret_anthropic_key", label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/ },
  {
    code: "secret_service_account",
    label: "Google service-account JSON",
    re: /"type"\s*:\s*"service_account"/,
  },
];

/** Google browser API keys are commonly shipped on purpose; flagged for a human decision. */
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/;

const FORBIDDEN_FILES: [RegExp, string][] = [
  [/(^|\/)\.env(\.[^/]*)?$/, "environment file"],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, "key or certificate file"],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, "SSH private key"],
  [/(^|\/)\.git\//, "git metadata"],
  [/(^|\/)\.npmrc$/, "npm credentials file"],
  [/\.crx$/i, "packed extension inside the package"],
];

const TEXT_EXT = /\.(m?js|cjs|html?|json|css|txt|svg|map|xml|ts|mjs|wasm\.js)$/i;
const SCRIPT_EXT = /\.(m?js|cjs)$/i;

/** Lines matching any of these load executable code from the network at runtime. */
const REMOTE_CODE_PATTERNS: [RegExp, string][] = [
  [/importScripts\s*\(\s*['"`]https?:\/\//, "importScripts() of a remote URL"],
  [/\bimport\s*\(\s*['"`]https?:\/\//, "dynamic import() of a remote URL"],
  [/^\s*import\s[^;]*from\s*['"]https?:\/\//m, "static import from a remote URL"],
  [
    /\.src\s*=\s*['"`]https?:\/\/[^'"`]+\.(m?js)(\?[^'"`]*)?['"`]/,
    "script element pointed at a remote .js URL",
  ],
];

const decoder = new TextDecoder("utf-8", { fatal: false });

export interface ScanOptions {
  /** Treat shipped source maps as errors rather than warnings. */
  strictSourceMaps?: boolean;
}

/** Scans package files for leaked credentials, forbidden files and remotely hosted code. */
export function scanFiles(files: ReadonlyMap<string, Uint8Array>, opts: ScanOptions = {}): Finding[] {
  const findings: Finding[] = [];
  for (const [name, data] of files) {
    for (const [re, label] of FORBIDDEN_FILES) {
      if (re.test(name))
        findings.push({
          severity: "error",
          code: "forbidden_file",
          message: `Package contains a ${label}`,
          file: name,
        });
    }
    if (name.endsWith(".map")) {
      findings.push({
        severity: opts.strictSourceMaps ? "error" : "warning",
        code: "source_map",
        message: "Source map ships readable original source to every tester",
        file: name,
      });
    }
    if (!TEXT_EXT.test(name) && !/(^|\/)\.env/.test(name)) continue;
    const text = decoder.decode(data);

    for (const p of SECRET_PATTERNS) {
      if (p.re.test(text))
        findings.push({
          severity: "error",
          code: p.code,
          message: `Looks like a ${p.label} is embedded`,
          file: name,
        });
    }
    if (GOOGLE_API_KEY.test(text)) {
      findings.push({
        severity: "warning",
        code: "google_api_key",
        message: "Google API key embedded; make sure it is restricted to this extension",
        file: name,
      });
    }
    if (SCRIPT_EXT.test(name)) {
      for (const [re, label] of REMOTE_CODE_PATTERNS) {
        if (re.test(text))
          findings.push({
            severity: "error",
            code: "remote_code",
            message: `Remotely hosted code: ${label}`,
            file: name,
          });
      }
      if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) {
        findings.push({
          severity: "warning",
          code: "dynamic_eval",
          message: "eval() / new Function() found; extension pages block it under the MV3 CSP",
          file: name,
        });
      }
    }
    if (/\.html?$/i.test(name)) {
      if (/<script[^>]+src\s*=\s*['"]?(https?:)?\/\//i.test(text)) {
        findings.push({
          severity: "error",
          code: "remote_code",
          message: "HTML loads a <script> from a remote URL",
          file: name,
        });
      }
      if (/<script(?![^>]*\bsrc\s*=)[^>]*>\s*\S/i.test(text)) {
        findings.push({
          severity: "warning",
          code: "inline_script",
          message: "Inline <script> will not run under the Manifest V3 CSP",
          file: name,
        });
      }
    }
  }
  return findings;
}
