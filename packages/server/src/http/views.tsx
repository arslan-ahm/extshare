import { type Finding, formatDuration, type ReleaseState } from "@extshare/core";
import type { Child, FC } from "hono/jsx";

export const STATE_LABEL: Record<ReleaseState, string> = {
  uploading: "Uploading",
  processing: "Processing",
  in_review: "In review",
  staged: "Staged",
  live: "Live",
  rejected: "Rejected",
  cancelled: "Cancelled",
  failed: "Failed",
  superseded: "Superseded",
  expired: "Expired",
  revoked: "Revoked",
};

const STATE_TONE: Record<ReleaseState, "ok" | "wait" | "bad" | "off"> = {
  uploading: "wait",
  processing: "wait",
  in_review: "wait",
  staged: "wait",
  live: "ok",
  rejected: "bad",
  cancelled: "off",
  failed: "bad",
  superseded: "off",
  expired: "off",
  revoked: "bad",
};

export const StateBadge: FC<{ state: ReleaseState }> = ({ state }) => (
  <span class={`badge badge-${STATE_TONE[state]}`}>{STATE_LABEL[state]}</span>
);

export function fmtTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const Time: FC<{ ms: number }> = ({ ms }) => (
  <time datetime={new Date(ms).toISOString()}>{fmtTime(ms)}</time>
);

export const Remaining: FC<{ until: number; now: number }> = ({ until, now }) =>
  until <= now ? <span class="muted">ended</span> : <span>{formatDuration(until - now)} left</span>;

export const Alert: FC<{ tone: "error" | "ok" | "info"; children?: Child }> = ({ tone, children }) => (
  <div class={`alert alert-${tone}`} role={tone === "error" ? "alert" : "status"}>
    {children}
  </div>
);

export const Findings: FC<{ findings: Finding[] }> = ({ findings }) =>
  findings.length === 0 ? (
    <p class="muted">No warnings. The package passed every check.</p>
  ) : (
    <ul class="findings">
      {findings.map((f) => (
        <li class={f.severity === "error" ? "finding-error" : "finding-warning"}>
          <span class="finding-sev">{f.severity}</span>
          <span>
            {f.message}
            {f.file ? <code class="finding-file">{f.file}</code> : null}
          </span>
        </li>
      ))}
    </ul>
  );

export const Csrf: FC<{ token: string }> = ({ token }) => <input type="hidden" name="_csrf" value={token} />;

export interface NavUser {
  email: string;
  workspaceName: string;
  csrf: string;
}

export const Layout: FC<{ title: string; user?: NavUser | null; narrow?: boolean; children?: Child }> = ({
  title,
  user,
  narrow,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="referrer" content="no-referrer" />
      <meta name="robots" content="noindex, nofollow" />
      <title>{`${title} | extshare`}</title>
      <link rel="stylesheet" href="/assets/app.css" />
    </head>
    <body>
      <header class="topbar">
        <div class="topbar-inner">
          <a class="brand" href={user ? "/" : "#"}>
            extshare
          </a>
          {user ? (
            <nav class="nav" aria-label="Main">
              <a href="/">Projects</a>
              <a href="/audit">Audit log</a>
              <a href="/device">Approve CLI</a>
              <span class="nav-user" title={user.email}>
                {user.workspaceName}
              </span>
              <form method="post" action="/logout" class="inline">
                <Csrf token={user.csrf} />
                <button type="submit" class="btn-link">
                  Sign out
                </button>
              </form>
            </nav>
          ) : null}
        </div>
      </header>
      <main class={narrow ? "page page-narrow" : "page"}>{children}</main>
    </body>
  </html>
);

export const Field: FC<{
  label: string;
  name: string;
  type?: string;
  hint?: string;
  value?: string;
  required?: boolean;
  autocomplete?: string;
  children?: Child;
}> = (p) => (
  <div class="field">
    <label for={`f-${p.name}`}>{p.label}</label>
    {p.children ?? (
      <input
        id={`f-${p.name}`}
        name={p.name}
        type={p.type ?? "text"}
        value={p.value}
        required={p.required}
        autocomplete={p.autocomplete}
      />
    )}
    {p.hint ? <p class="hint">{p.hint}</p> : null}
  </div>
);
