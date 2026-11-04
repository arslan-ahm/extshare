import { parseVersion } from "./version";

export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  file?: string;
}

/** Permissions that trigger strong install warnings or heightened Web Store review. */
export const SENSITIVE_PERMISSIONS = new Set([
  "debugger",
  "nativeMessaging",
  "proxy",
  "webRequest",
  "webRequestBlocking",
  "declarativeNetRequestWithHostAccess",
  "cookies",
  "history",
  "management",
  "privacy",
  "tabCapture",
  "desktopCapture",
  "pageCapture",
  "clipboardRead",
  "downloads",
  "geolocation",
  "contentSettings",
  "enterprise.deviceAttributes",
  "vpnProvider",
]);

const BROAD_HOSTS = new Set(["<all_urls>", "*://*/*", "http://*/*", "https://*/*"]);
const CWS_NAME_MAX = 75;
const CWS_DESCRIPTION_MAX = 132;

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Paths in the manifest are relative to the package root and may carry a leading slash. */
function normalizeRef(ref: string): string {
  return ref.replace(/^\.?\//, "").split(/[?#]/)[0]!;
}

/** Checks a script-src style CSP string for anything that would load remotely hosted code. */
export function cspRemoteCodeFindings(csp: string, label: string): Finding[] {
  const out: Finding[] = [];
  for (const directive of csp.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (!name || !["script-src", "default-src", "object-src", "worker-src"].includes(name)) continue;
    for (const src of sources) {
      const lower = src.toLowerCase();
      if (lower === "'unsafe-eval'" || lower === "'unsafe-inline'") {
        out.push({
          severity: "error",
          code: "csp_unsafe",
          message: `${label} allows ${src} in ${name}; Manifest V3 forbids it`,
        });
      } else if (
        /^(https?:|wss?:|\*|data:|blob:)/.test(lower) &&
        !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(lower)
      ) {
        out.push({
          severity: "error",
          code: "remote_code_csp",
          message: `${label} allows remote source ${src} in ${name}; Manifest V3 forbids remotely hosted code`,
        });
      }
    }
  }
  return out;
}

export interface ManifestSummary {
  name: string;
  version: string;
  description: string | null;
  permissions: string[];
  hostPermissions: string[];
}

/**
 * Validates a parsed manifest.json against Manifest V3 and Chrome Web Store upload rules.
 * `files` is the set of file paths in the package, used to check every referenced file exists.
 */
export function validateManifest(
  manifest: unknown,
  files: ReadonlySet<string>,
): { findings: Finding[]; summary: ManifestSummary | null } {
  const findings: Finding[] = [];
  const err = (code: string, message: string) =>
    findings.push({ severity: "error", code, message, file: "manifest.json" });
  const warn = (code: string, message: string) =>
    findings.push({ severity: "warning", code, message, file: "manifest.json" });

  if (!isObj(manifest)) {
    err("manifest_not_object", "manifest.json must be a JSON object");
    return { findings, summary: null };
  }
  const m = manifest;
  const requireFile = (ref: unknown, field: string) => {
    if (typeof ref !== "string" || ref.length === 0) {
      err("manifest_bad_field", `${field} must be a non-empty string`);
      return;
    }
    if (/^[a-z]+:/i.test(ref)) {
      err("remote_reference", `${field} points to "${ref}"; every file must ship inside the package`);
      return;
    }
    const path = normalizeRef(ref);
    if (!files.has(path)) err("missing_file", `${field} references "${ref}", which is not in the package`);
  };

  if (m.manifest_version !== 3)
    err("manifest_version", `manifest_version must be 3 (found ${JSON.stringify(m.manifest_version)})`);

  const defaultLocale = typeof m.default_locale === "string" ? m.default_locale : null;
  if (defaultLocale && !files.has(`_locales/${defaultLocale}/messages.json`)) {
    err(
      "missing_locale",
      `default_locale is "${defaultLocale}" but _locales/${defaultLocale}/messages.json is missing`,
    );
  }
  const usesMsg = (s: string) => /^__MSG_\w+__$/.test(s);

  if (typeof m.name !== "string" || m.name.trim() === "") {
    err("name_missing", "name is required");
  } else if (usesMsg(m.name)) {
    if (!defaultLocale) err("missing_locale", "name uses __MSG_ but default_locale is not set");
  } else if (m.name.length > CWS_NAME_MAX) {
    err(
      "name_too_long",
      `name is ${m.name.length} characters; the Chrome Web Store limit is ${CWS_NAME_MAX}`,
    );
  }

  if (typeof m.version !== "string" || !parseVersion(m.version)) {
    err(
      "version_invalid",
      `version ${JSON.stringify(m.version)} is not a valid Chrome version (1-4 integers 0-65535, no leading zeros)`,
    );
  }

  if (m.description !== undefined) {
    if (typeof m.description !== "string") err("manifest_bad_field", "description must be a string");
    else if (!usesMsg(m.description) && m.description.length > CWS_DESCRIPTION_MAX) {
      err(
        "description_too_long",
        `description is ${m.description.length} characters; the Chrome Web Store limit is ${CWS_DESCRIPTION_MAX}`,
      );
    }
  } else {
    warn("description_missing", "description is missing; the Chrome Web Store listing will show none");
  }

  if (!isObj(m.icons)) {
    err("icon_missing", 'icons is required, with at least a "128" icon for the Chrome Web Store');
  } else {
    if (!("128" in m.icons)) err("icon_missing", 'icons must include a "128" entry for the Chrome Web Store');
    for (const [size, ref] of Object.entries(m.icons)) requireFile(ref, `icons.${size}`);
  }

  if (m.background !== undefined) {
    if (!isObj(m.background)) err("manifest_bad_field", "background must be an object");
    else {
      if ("scripts" in m.background || "page" in m.background) {
        err(
          "background_mv2",
          "background.scripts / background.page are Manifest V2; use background.service_worker",
        );
      }
      if ("service_worker" in m.background)
        requireFile(m.background.service_worker, "background.service_worker");
    }
  }

  if (m.content_scripts !== undefined) {
    if (!Array.isArray(m.content_scripts)) err("manifest_bad_field", "content_scripts must be an array");
    else
      m.content_scripts.forEach((cs, i) => {
        if (!isObj(cs)) {
          err("manifest_bad_field", `content_scripts[${i}] must be an object`);
          return;
        }
        for (const f of strArray(cs.js)) requireFile(f, `content_scripts[${i}].js`);
        for (const f of strArray(cs.css)) requireFile(f, `content_scripts[${i}].css`);
        if (strArray(cs.matches).length === 0)
          err("manifest_bad_field", `content_scripts[${i}].matches must list at least one pattern`);
      });
  }

  const pageFields: [unknown, string][] = [
    [isObj(m.action) ? m.action.default_popup : undefined, "action.default_popup"],
    [m.options_page, "options_page"],
    [isObj(m.options_ui) ? m.options_ui.page : undefined, "options_ui.page"],
    [isObj(m.side_panel) ? m.side_panel.default_path : undefined, "side_panel.default_path"],
    [m.devtools_page, "devtools_page"],
  ];
  for (const [ref, field] of pageFields) if (ref !== undefined) requireFile(ref, field);
  if (isObj(m.action) && isObj(m.action.default_icon)) {
    for (const [size, ref] of Object.entries(m.action.default_icon))
      requireFile(ref, `action.default_icon.${size}`);
  }
  if (m.browser_action !== undefined || m.page_action !== undefined) {
    err("action_mv2", "browser_action / page_action are Manifest V2; use action");
  }

  if (m.key !== undefined)
    err("key_field", 'remove the "key" field; the Chrome Web Store rejects packages that contain it');
  if (m.update_url !== undefined)
    err("update_url", 'remove "update_url"; Web Store items are updated by the store');

  const csp = m.content_security_policy;
  if (typeof csp === "string") err("csp_mv2", "content_security_policy must be an object in Manifest V3");
  else if (isObj(csp)) {
    for (const key of ["extension_pages", "sandbox"] as const) {
      const v = csp[key];
      if (typeof v === "string" && key === "extension_pages")
        findings.push(...cspRemoteCodeFindings(v, `content_security_policy.${key}`));
    }
  }

  const permissions = strArray(m.permissions);
  const hostPermissions = strArray(m.host_permissions);
  const hostInPermissions = permissions.filter((p) => p.includes("://") || p === "<all_urls>");
  if (hostInPermissions.length > 0) {
    err(
      "host_in_permissions",
      `Move host patterns to host_permissions in Manifest V3: ${hostInPermissions.join(", ")}`,
    );
  }
  const sensitive = permissions.filter((p) => SENSITIVE_PERMISSIONS.has(p));
  if (sensitive.length > 0) {
    warn(
      "sensitive_permissions",
      `Sensitive permissions (testers will see warnings; review may take longer): ${sensitive.join(", ")}`,
    );
  }
  const broad = [...hostPermissions, ...strArray(m.optional_host_permissions)].filter((h) =>
    BROAD_HOSTS.has(h),
  );
  if (broad.length > 0) warn("broad_host_permissions", `Broad host access requested: ${broad.join(", ")}`);
  const csBroad = Array.isArray(m.content_scripts)
    ? m.content_scripts.flatMap((cs) =>
        isObj(cs) ? strArray(cs.matches).filter((x) => BROAD_HOSTS.has(x)) : [],
      )
    : [];
  if (csBroad.length > 0) warn("broad_content_scripts", "Content scripts run on every site");

  return {
    findings,
    summary:
      typeof m.name === "string" && typeof m.version === "string"
        ? {
            name: m.name,
            version: m.version,
            description: typeof m.description === "string" ? m.description : null,
            permissions,
            hostPermissions,
          }
        : null,
  };
}
