import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import {
  type AuditDto,
  type DeviceStartDto,
  type DeviceTokenResponse,
  type Finding,
  formatDuration,
  type InviteDto,
  inspectPackage,
  isValidEmail,
  type MeDto,
  type ProjectDto,
  type PublishResultDto,
  parseTtl,
  type ReleaseDto,
  sha256Hex,
  type TokenDto,
} from "@extshare/core";
import { Api, ApiError, publicCall } from "./client";
import {
  type CliContext,
  CliError,
  normalizeServer,
  readCredentials,
  readProjectConfig,
  writeCredentials,
  writeProjectConfig,
} from "./context";
import { packPath } from "./pack";

type Args = string[];

// States the Web Store will move on its own. `staged` waits for the developer, so --wait stops there.
const WAITING_ON_STORE = ["uploading", "processing", "in_review"];

const fmtTime = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function printFindings(ctx: CliContext, findings: Finding[]) {
  for (const f of findings) {
    ctx.err(
      `  ${f.severity === "error" ? "ERROR  " : "warning"} ${f.message}${f.file ? `  (${f.file})` : ""}`,
    );
  }
}

function emit(ctx: CliContext, data: unknown, human: () => void) {
  if (ctx.json) ctx.out(JSON.stringify(data, null, 2));
  else human();
}

function printRelease(ctx: CliContext, r: ReleaseDto) {
  ctx.out(`Release   ${r.id}${r.kind === "withdrawal" ? " (withdrawal build)" : ""}`);
  ctx.out(`Version   ${r.version}`);
  ctx.out(`Status    ${r.state}: ${r.stateDetail}`);
  const left = r.expiresAt - Date.now();
  ctx.out(
    `Window    until ${fmtTime(r.expiresAt)}${r.state === "revoked" || r.state === "expired" ? "" : left > 0 ? ` (${formatDuration(left)} left)` : ""}`,
  );
  ctx.out(`Testers   ${r.testers.length ? r.testers.join(", ") : "none"}`);
  ctx.out(`SHA-256   ${r.sha256}`);
}

function splitEmails(s: string | undefined): string[] {
  const list = (s ?? "")
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const bad = list.filter((e) => !isValidEmail(e));
  if (bad.length) throw new CliError(`Invalid email address: ${bad.join(", ")}`);
  return list;
}

function projectId(ctx: CliContext, flag: string | undefined): string {
  if (flag) return flag;
  const pc = readProjectConfig(ctx);
  if (!pc)
    throw new CliError(
      "No project selected. Run extshare init --project <id> in your extension folder, or pass --project.",
    );
  const loggedInTo = readCredentials(ctx)?.server;
  if (loggedInTo && loggedInTo !== pc.server) {
    throw new CliError(
      `extshare.json points at ${pc.server} but you are logged in to ${loggedInTo}. Run: extshare login --server ${pc.server}`,
      2,
    );
  }
  return pc.projectId;
}

function parse<O extends NonNullable<ParseArgsConfig["options"]>>(args: Args, options: O, positionals = 0) {
  try {
    const r = parseArgs({ args, options, allowPositionals: positionals > 0, strict: true });
    if (r.positionals.length > positionals)
      throw new CliError(`Unexpected argument: ${r.positionals[positionals]}`, 2);
    return r;
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, 2);
  }
}

// ---------------- auth ----------------

export async function login(ctx: CliContext, args: Args) {
  const { values } = parse(args, { server: { type: "string" }, "no-browser": { type: "boolean" } });
  const server = normalizeServer(
    values.server ?? readProjectConfig(ctx)?.server ?? readCredentials(ctx)?.server ?? "",
  );
  const start = await publicCall<DeviceStartDto>(ctx, server, "/api/device/start", {
    clientName: `extshare CLI on ${process.platform}`,
  });
  const d = start.body;
  ctx.err(
    `To approve this login, open:\n\n  ${d.verificationUriComplete}\n\nand confirm the code ${d.userCode}. Waiting...`,
  );
  if (!values["no-browser"]) ctx.openBrowser(d.verificationUriComplete);

  let interval = d.intervalSec * 1000;
  const deadline = ctx.now() + d.expiresInSec * 1000;
  while (ctx.now() < deadline) {
    await ctx.sleep(interval);
    let r: { status: number; body: DeviceTokenResponse };
    try {
      r = await publicCall<DeviceTokenResponse>(ctx, server, "/api/device/token", {
        deviceCode: d.deviceCode,
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "rate_limited") {
        interval += 5000;
        continue;
      }
      if (e instanceof ApiError) throw new CliError(`Login failed: ${e.message}`, 3);
      throw e;
    }
    if ("pending" in r.body) {
      if (r.body.slowDown) interval += 5000;
      continue;
    }
    const tokens = r.body as TokenDto;
    const me = await new Api(ctx, { ...tokens, server, email: "" }).request<MeDto>("GET", "/api/me");
    writeCredentials(ctx, { ...tokens, server, email: me.email });
    emit(ctx, me, () =>
      ctx.out(`Logged in as ${me.email} (workspace ${me.workspace.name}, role ${me.workspace.role}).`),
    );
    return;
  }
  throw new CliError("Login timed out. Run extshare login again.", 3);
}

export async function logout(ctx: CliContext) {
  const creds = readCredentials(ctx);
  if (creds?.accessToken) {
    try {
      await new Api(ctx, creds).request("POST", "/api/logout");
    } catch {
      // The local credentials are removed regardless; a dead server must not block logout.
    }
  }
  writeCredentials(ctx, null);
  ctx.out("Logged out.");
}

export async function whoami(ctx: CliContext) {
  const api = new Api(ctx);
  const me = await api.request<MeDto>("GET", "/api/me");
  emit(ctx, { ...me, server: api.server }, () =>
    ctx.out(
      `${me.email} on ${api.server}\nWorkspace ${me.workspace.name} (${me.workspace.id}), role ${me.workspace.role}`,
    ),
  );
}

// ---------------- projects ----------------

export async function projects(ctx: CliContext, args: Args) {
  const [sub, ...rest] = args;
  const api = new Api(ctx);
  if (!sub || sub === "list") {
    const list = await api.request<ProjectDto[]>("GET", "/api/projects");
    emit(ctx, list, () => {
      if (list.length === 0)
        ctx.out(
          "No projects. Create one: extshare projects create --name <n> --item-id <id> --visibility private",
        );
      for (const p of list) ctx.out(`${p.id}  ${p.visibility.padEnd(8)}  ${p.itemId}  ${p.name}`);
    });
    return;
  }
  if (sub === "create") {
    const { values } = parse(rest, {
      name: { type: "string" },
      "item-id": { type: "string" },
      visibility: { type: "string" },
    });
    if (!values.name || !values["item-id"] || !values.visibility) {
      throw new CliError(
        "Usage: extshare projects create --name <name> --item-id <32-char id> --visibility private|unlisted",
        2,
      );
    }
    const p = await api.request<ProjectDto>("POST", "/api/projects", {
      name: values.name,
      itemId: values["item-id"],
      visibility: values.visibility,
    });
    emit(ctx, p, () =>
      ctx.out(`Created project ${p.id} for ${p.webStoreUrl}\nNext: extshare init --project ${p.id}`),
    );
    return;
  }
  throw new CliError(`Unknown subcommand: projects ${sub}`, 2);
}

export async function init(ctx: CliContext, args: Args) {
  const { values } = parse(args, { project: { type: "string" }, server: { type: "string" } });
  if (!values.project) throw new CliError("Usage: extshare init --project <projectId>", 2);
  const api = new Api(ctx);
  const server = values.server ? normalizeServer(values.server) : api.server;
  const p = await api.request<ProjectDto>("GET", `/api/projects/${encodeURIComponent(values.project)}`);
  writeProjectConfig(ctx, { server, projectId: p.id });
  ctx.out(`Linked this folder to "${p.name}" (${p.id}). Wrote extshare.json.`);
}

// ---------------- validate / publish ----------------

export async function validate(ctx: CliContext, args: Args) {
  const { values, positionals } = parse(args, { "strict-source-maps": { type: "boolean" } }, 1);
  const target = resolve(ctx.cwd, positionals[0] ?? ".");
  const { zip, files, skipped } = packPath(target);
  const report = inspectPackage(zip, { strictSourceMaps: values["strict-source-maps"] });
  emit(ctx, report, () => {
    ctx.out(
      `${report.manifest?.name ?? "?"} ${report.manifest?.version ?? "?"}: ${report.fileCount || files.length} files, ${(report.sizeBytes / 1024).toFixed(1)} KB`,
    );
    if (skipped.length) ctx.out(`Skipped: ${skipped.join(", ")}`);
    printFindings(ctx, report.findings);
    ctx.out(report.ok ? "Package is valid." : "Package has errors.");
  });
  if (!report.ok) throw new CliError("Validation failed", 1);
}

export async function publish(ctx: CliContext, args: Args) {
  const { values, positionals } = parse(
    args,
    {
      project: { type: "string" },
      ttl: { type: "string", default: "7d" },
      testers: { type: "string" },
      notes: { type: "string", default: "" },
      staged: { type: "boolean" },
      "no-inherit-testers": { type: "boolean" },
      "strict-source-maps": { type: "boolean" },
      wait: { type: "boolean" },
      visibility: { type: "string" },
    },
    1,
  );
  const pid = projectId(ctx, values.project);
  try {
    parseTtl(values.ttl!);
  } catch (e) {
    throw new CliError((e as Error).message, 2);
  }
  const testers = splitEmails(values.testers);
  const target = resolve(ctx.cwd, positionals[0] ?? ".");
  const { zip } = packPath(target);

  // Local check first for fast feedback; the server repeats it and is authoritative.
  const report = inspectPackage(zip, { strictSourceMaps: values["strict-source-maps"] });
  if (!report.ok) {
    printFindings(ctx, report.findings);
    throw new CliError("Package failed validation; nothing was uploaded.");
  }
  const api = new Api(ctx);
  if (values.visibility) {
    const p = await api.request<ProjectDto>("GET", `/api/projects/${encodeURIComponent(pid)}`);
    if (p.visibility !== values.visibility) {
      throw new CliError(
        `This project's Web Store item is ${p.visibility}. Visibility is set per item in the Developer Dashboard, not per upload.`,
        2,
      );
    }
  }
  ctx.err(
    `Uploading ${report.manifest!.name} ${report.manifest!.version} (${(zip.length / 1024).toFixed(1)} KB)...`,
  );
  const meta = {
    ttl: values.ttl,
    testers,
    notes: values.notes,
    inheritTesters: !values["no-inherit-testers"],
    publishType: values.staged ? "STAGED_PUBLISH" : "DEFAULT_PUBLISH",
    strictSourceMaps: Boolean(values["strict-source-maps"]),
  };
  const res = await api.raw(
    "POST",
    `/api/projects/${encodeURIComponent(pid)}/releases`,
    () => {
      const fd = new FormData();
      fd.set("meta", JSON.stringify(meta));
      fd.set("package", new File([new Uint8Array(zip)], "package.zip", { type: "application/zip" }));
      return fd;
    },
    { "x-content-sha256": sha256Hex(zip) },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code: string; message: string; findings?: Finding[] };
    };
    if (body.error?.findings?.length) printFindings(ctx, body.error.findings);
    throw new ApiError(
      res.status,
      body.error?.code ?? "http_error",
      body.error?.message ?? `HTTP ${res.status}`,
    );
  }
  let { release, invite } = (await res.json()) as PublishResultDto;

  if (values.wait && WAITING_ON_STORE.includes(release.state)) {
    ctx.err("Waiting for the Chrome Web Store (Ctrl+C to stop waiting; the release continues)...");
    while (WAITING_ON_STORE.includes(release.state)) {
      await ctx.sleep(30_000);
      release = await api.request<ReleaseDto>("POST", `/api/releases/${release.id}/sync`);
    }
  }

  emit(ctx, { release, invite }, () => {
    printRelease(ctx, release);
    if (release.findings.length) {
      ctx.out("Warnings:");
      printFindings(ctx, release.findings);
    }
    if (invite) {
      ctx.out(`\nShare link (shown once, valid until ${fmtTime(invite.expiresAt)}):\n  ${invite.url}`);
    }
    if (release.state === "in_review")
      ctx.out("\nThe Web Store is reviewing this version. Testers see the install button once it is live.");
  });
  if (release.state === "failed" || release.state === "rejected")
    throw new CliError(`Publish ${release.state}: ${release.stateDetail}`);
}

// ---------------- release management ----------------

export async function status(ctx: CliContext, args: Args) {
  const { values, positionals } = parse(args, { sync: { type: "boolean" } }, 1);
  if (!positionals[0]) throw new CliError("Usage: extshare status <releaseId> [--sync]", 2);
  const api = new Api(ctx);
  const r = values.sync
    ? await api.request<ReleaseDto>("POST", `/api/releases/${encodeURIComponent(positionals[0])}/sync`)
    : await api.request<ReleaseDto>("GET", `/api/releases/${encodeURIComponent(positionals[0])}`);
  emit(ctx, r, () => printRelease(ctx, r));
}

export async function releases(ctx: CliContext, args: Args) {
  const { values } = parse(args, { project: { type: "string" } });
  const list = await new Api(ctx).request<ReleaseDto[]>(
    "GET",
    `/api/projects/${encodeURIComponent(projectId(ctx, values.project))}/releases`,
  );
  emit(ctx, list, () => {
    if (list.length === 0)
      ctx.out("No releases yet. Publish one: extshare publish ./dist --testers you@example.com");
    for (const r of list)
      ctx.out(
        `${r.id}  ${r.version.padEnd(12)}  ${r.state.padEnd(11)}  ${fmtTime(r.createdAt)}  ${r.createdBy}`,
      );
  });
}

export async function invite(ctx: CliContext, args: Args) {
  const { values, positionals } = parse(args, { ttl: { type: "string" } }, 1);
  if (!positionals[0]) throw new CliError("Usage: extshare invite <releaseId> [--ttl 2d]", 2);
  const inv = await new Api(ctx).request<InviteDto>(
    "POST",
    `/api/releases/${encodeURIComponent(positionals[0])}/invites`,
    values.ttl ? { ttl: values.ttl } : {},
  );
  emit(ctx, inv, () =>
    ctx.out(
      `New share link (earlier links no longer work), valid until ${fmtTime(inv.expiresAt)}:\n  ${inv.url}`,
    ),
  );
}

export async function testers(ctx: CliContext, args: Args) {
  const { values, positionals } = parse(args, { add: { type: "string" }, remove: { type: "string" } }, 1);
  if (!positionals[0])
    throw new CliError("Usage: extshare testers <releaseId> [--add a@x.com,b@y.com] [--remove c@z.com]", 2);
  const api = new Api(ctx);
  const id = encodeURIComponent(positionals[0]);
  const list =
    values.add || values.remove
      ? await api.request<string[]>("POST", `/api/releases/${id}/testers`, {
          add: splitEmails(values.add),
          remove: splitEmails(values.remove),
        })
      : await api.request<string[]>("GET", `/api/releases/${id}/testers`);
  emit(ctx, list, () => ctx.out(list.length ? list.join("\n") : "No testers."));
}

export async function extend(ctx: CliContext, args: Args) {
  const { values, positionals } = parse(args, { ttl: { type: "string" } }, 1);
  if (!positionals[0] || !values.ttl) throw new CliError("Usage: extshare extend <releaseId> --ttl 3d", 2);
  const r = await new Api(ctx).request<ReleaseDto>(
    "POST",
    `/api/releases/${encodeURIComponent(positionals[0])}/extend`,
    { ttl: values.ttl },
  );
  emit(ctx, r, () => ctx.out(`Window now ends ${fmtTime(r.expiresAt)}.`));
}

export async function revoke(ctx: CliContext, args: Args) {
  const { values, positionals } = parse(
    args,
    {
      reason: { type: "string", default: "" },
      "kill-switch": { type: "boolean" },
      "no-cancel": { type: "boolean" },
      yes: { type: "boolean" },
    },
    1,
  );
  if (!positionals[0])
    throw new CliError("Usage: extshare revoke <releaseId> [--reason text] [--kill-switch] [--no-cancel]", 2);
  if (values["kill-switch"] && !values.yes) {
    throw new CliError(
      "--kill-switch publishes an empty successor version to every user of this Web Store item (after review). Re-run with --yes to confirm.",
      2,
    );
  }
  const r = await new Api(ctx).request<{ release: ReleaseDto; withdrawal: ReleaseDto | null }>(
    "POST",
    `/api/releases/${encodeURIComponent(positionals[0])}/revoke`,
    {
      reason: values.reason,
      cancelSubmission: !values["no-cancel"],
      killSwitch: Boolean(values["kill-switch"]),
    },
  );
  emit(ctx, r, () => {
    ctx.out(`Revoked ${r.release.id}. Every share link for it stopped working.`);
    if (r.withdrawal) {
      ctx.out(
        `Withdrawal build ${r.withdrawal.version} submitted (${r.withdrawal.state}). Installed copies update to it once the Web Store approves it.`,
      );
    } else {
      ctx.out(
        "Copies already installed keep working until testers remove them. Use --kill-switch to push a disabled update.",
      );
    }
  });
}

export async function audit(ctx: CliContext, args: Args) {
  const { positionals } = parse(args, {}, 1);
  if (!positionals[0]) throw new CliError("Usage: extshare audit <releaseId>", 2);
  const rows = await new Api(ctx).request<AuditDto[]>(
    "GET",
    `/api/releases/${encodeURIComponent(positionals[0])}/audit`,
  );
  emit(ctx, rows, () => {
    for (const e of rows)
      ctx.out(`${fmtTime(e.at)}  ${e.action.padEnd(24)}  ${e.actor}${e.ip ? `  ${e.ip}` : ""}`);
  });
}

export async function download(ctx: CliContext, args: Args) {
  const { values, positionals } = parse(args, { output: { type: "string", short: "o" } }, 1);
  if (!positionals[0]) throw new CliError("Usage: extshare download <releaseId> [-o file.zip]", 2);
  const res = await new Api(ctx).raw("GET", `/api/releases/${encodeURIComponent(positionals[0])}/artifact`);
  if (!res.ok) throw new ApiError(res.status, "download_failed", `Download failed (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const expected = res.headers.get("x-content-sha256");
  if (expected && sha256Hex(bytes) !== expected)
    throw new CliError("Downloaded package does not match its recorded hash");
  const out = resolve(ctx.cwd, values.output ?? `${positionals[0]}.zip`);
  writeFileSync(out, bytes);
  ctx.out(`Saved ${out} (${bytes.length} bytes, sha256 ${expected}).`);
}
