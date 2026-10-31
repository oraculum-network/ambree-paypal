// Round 2: the database carries a schema version; an older (or newer) one is refused, not half-used.

import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.ts";

const dir = new URL("../.data/schema-test/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = () => `${dir}${randomUUID()}.sqlite`;

describe("round 2: schema version", () => {
  it("refuses a build-1 database (no version, old webhook table)", () => {
    const path = file();
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE ledger (seq INTEGER PRIMARY KEY, at TEXT, booking_id TEXT, kind TEXT, data TEXT, prev_hash TEXT, hash TEXT); CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, event_type TEXT, received_at TEXT);");
    old.close();
    expect(() => openDb(path)).toThrow(/schema version 0\b.*older/);
  });

  it("refuses a database from a newer build", () => {
    const path = file();
    const db = openDb(path);
    db.exec("PRAGMA user_version = 999");
    db.close();
    expect(() => openDb(path)).toThrow(/schema version 999\b.*newer/);
  });

  it("a fresh file gets the current version and reopens", () => {
    const path = file();
    const db = openDb(path);
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBeGreaterThan(0);
    db.close();
    const again = openDb(path);
    expect((again.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(v);
    again.close();
  });
});
