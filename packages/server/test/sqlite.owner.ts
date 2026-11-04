/**
 * OWNER-RUN ONLY: `bun run verify:sqlite`
 *
 * Runs the shared Store contract against the real SqliteStore. Each case creates a fresh SQLite
 * file in a new temporary directory, applies migrations/001_init.sql, and deletes the directory
 * afterwards. It never touches DATA_DIR or any existing database. Not picked up by `bun test`
 * because the filename does not end in .test.ts.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, SqliteStore } from "../src/store/sqlite";
import { storeContract } from "./store-contract";

const dirs: string[] = [];
const opened: SqliteStore[] = [];

function fresh(): SqliteStore {
  const dir = mkdtempSync(join(tmpdir(), "extshare-verify-"));
  dirs.push(dir);
  const s = SqliteStore.open(join(dir, "verify.db"));
  opened.push(s);
  return s;
}

afterAll(() => {
  for (const s of opened) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("SqliteStore contract", () => {
  storeContract("sqlite", fresh);
});

describe("SqliteStore schema behaviour", () => {
  test("migrations apply once and are recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "extshare-verify-"));
    dirs.push(dir);
    const db = new Database(join(dir, "m.db"), { create: true });
    expect(migrate(db)).toEqual(["001_init.sql"]);
    expect(migrate(db)).toEqual([]);
    db.close();
  });

  test("audit_log is append-only at the database level", () => {
    const dir = mkdtempSync(join(tmpdir(), "extshare-verify-"));
    dirs.push(dir);
    const db = new Database(join(dir, "a.db"), { create: true });
    migrate(db);
    db.run("INSERT INTO audit_log (id, at, actor, action, target) VALUES ('a', 1, 'x', 'y', 'z')");
    expect(() => db.run("UPDATE audit_log SET actor = 'evil'")).toThrow(/append-only/);
    expect(() => db.run("DELETE FROM audit_log")).toThrow(/append-only/);
    db.close();
  });

  test("CHECK constraints reject invalid enum values", () => {
    const s = fresh();
    s.createWorkspace({ id: "w", name: "w", createdAt: 1 });
    expect(() =>
      s.createProject({
        id: "p",
        workspaceId: "w",
        name: "n",
        itemId: "a".repeat(32),
        visibility: "public" as never,
        createdBy: "x",
        createdAt: 1,
      }),
    ).toThrow();
  });
});
