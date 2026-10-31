// Storage: one node:sqlite database (a file in production, :memory: in tests). Three tables:
// the append-only ledger, JSON records by kind (bookings, mandates), and seen webhook event ids.

import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = ${path === ":memory:" ? "MEMORY" : "WAL"};
    CREATE TABLE IF NOT EXISTS ledger (
      seq INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      booking_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS ledger_booking ON ledger (booking_id, seq);
    CREATE TABLE IF NOT EXISTS records (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      received_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received',
      attempts INTEGER NOT NULL DEFAULT 0,
      logged INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
  `);
  return db;
}

/** JSON records of one kind. Writes are synchronous, so a read-check-write in one call is atomic. */
export class Records<T extends { id: string }> {
  readonly #db: Db;
  readonly #kind: string;

  constructor(db: Db, kind: string) {
    this.#db = db;
    this.#kind = kind;
  }

  get(id: string): T | undefined {
    const row = this.#db.prepare("SELECT json FROM records WHERE kind = ? AND id = ?").get(this.#kind, id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  put(value: T): T {
    this.#db.prepare("INSERT INTO records (kind, id, json) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET json = excluded.json").run(this.#kind, value.id, JSON.stringify(value));
    return value;
  }

  list(): T[] {
    const rows = this.#db.prepare("SELECT json FROM records WHERE kind = ? ORDER BY rowid").all(this.#kind) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as T);
  }
}

export type WebhookStatus = "received" | "processing" | "completed" | "failed";

/**
 * Starts processing a verified webhook event. Only a `completed` event is a duplicate: a `failed` (or
 * interrupted `processing`) one is processed again on redelivery. `logged` says whether its ledger row
 * was already written, so a retry never writes it twice.
 */
export function beginWebhook(db: Db, eventId: string, eventType: string, at: string): { duplicate: true } | { duplicate: false; logged: boolean; attempts: number } {
  db.prepare("INSERT OR IGNORE INTO webhook_events (event_id, event_type, received_at, status, attempts, logged, updated_at) VALUES (?, ?, ?, 'received', 0, 0, ?)").run(eventId, eventType, at, at);
  const row = db.prepare("SELECT status, attempts, logged FROM webhook_events WHERE event_id = ?").get(eventId) as { status: WebhookStatus; attempts: number; logged: number };
  if (row.status === "completed") return { duplicate: true };
  db.prepare("UPDATE webhook_events SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE event_id = ?").run(at, eventId);
  return { duplicate: false, logged: row.logged === 1, attempts: row.attempts + 1 };
}

export function finishWebhook(db: Db, eventId: string, status: "completed" | "failed", at: string): void {
  db.prepare("UPDATE webhook_events SET status = ?, updated_at = ? WHERE event_id = ?").run(status, at, eventId);
}

export function markWebhookLogged(db: Db, eventId: string): void {
  db.prepare("UPDATE webhook_events SET logged = 1 WHERE event_id = ?").run(eventId);
}

/** Records a webhook event id; false if it was already seen (a redelivery). */
export function markWebhookSeen(db: Db, eventId: string, eventType: string, at: string): boolean {
  const r = db.prepare("INSERT OR IGNORE INTO webhook_events (event_id, event_type, received_at) VALUES (?, ?, ?)").run(eventId, eventType, at);
  return Number(r.changes) === 1;
}
