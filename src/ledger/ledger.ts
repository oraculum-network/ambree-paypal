// The hash-chained ledger: every step of every booking, append-only. Each row's hash covers its own
// fields and the previous row's hash, so editing, deleting or reordering any row breaks verify().
// This module has no update or delete; the tamper tests change the table directly.

import type { Db } from "../store/db.ts";
import { hashOf } from "./canonical.ts";

export const GENESIS = "0".repeat(64);

export interface LedgerEntry {
  seq: number;
  at: string;
  booking_id: string;
  kind: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export type VerifyResult = { ok: true; count: number; head: string } | { ok: false; count: number; bad_seq: number; reason: string };

export function entryHash(e: Omit<LedgerEntry, "hash">): string {
  return hashOf({ seq: e.seq, at: e.at, booking_id: e.booking_id, kind: e.kind, data: e.data, prev_hash: e.prev_hash });
}

type Row = { seq: number; at: string; booking_id: string; kind: string; data: string; prev_hash: string; hash: string };

function fromRow(r: Row): LedgerEntry {
  return { ...r, data: JSON.parse(r.data) as Record<string, unknown> };
}

export class Ledger {
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  append(booking_id: string, kind: string, data: Record<string, unknown> = {}): LedgerEntry {
    // Round-trip through JSON so what we hash is exactly what a reader will parse back.
    const clean = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    const last = this.#db.prepare("SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
    const base = { seq: (last?.seq ?? 0) + 1, at: this.#now().toISOString(), booking_id, kind, data: clean, prev_hash: last?.hash ?? GENESIS };
    const entry: LedgerEntry = { ...base, hash: entryHash(base) };
    this.#db
      .prepare("INSERT INTO ledger (seq, at, booking_id, kind, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entry.seq, entry.at, entry.booking_id, entry.kind, JSON.stringify(entry.data), entry.prev_hash, entry.hash);
    return entry;
  }

  list(booking_id?: string): LedgerEntry[] {
    const rows = booking_id
      ? (this.#db.prepare("SELECT * FROM ledger WHERE booking_id = ? ORDER BY seq").all(booking_id) as Row[])
      : (this.#db.prepare("SELECT * FROM ledger ORDER BY seq").all() as Row[]);
    return rows.map(fromRow);
  }

  /** Walks the whole chain from the first row and reports the first row that does not hold. */
  verify(): VerifyResult {
    const rows = this.#db.prepare("SELECT * FROM ledger ORDER BY seq").all() as Row[];
    let prev = GENESIS;
    let expectedSeq = 1;
    for (const r of rows) {
      let entry: LedgerEntry;
      try {
        entry = fromRow(r);
      } catch {
        return { ok: false, count: rows.length, bad_seq: r.seq, reason: "data is not JSON" };
      }
      if (r.seq !== expectedSeq) return { ok: false, count: rows.length, bad_seq: r.seq, reason: `expected seq ${expectedSeq}` };
      if (r.prev_hash !== prev) return { ok: false, count: rows.length, bad_seq: r.seq, reason: "prev_hash does not match the previous row" };
      if (entryHash(entry) !== r.hash) return { ok: false, count: rows.length, bad_seq: r.seq, reason: "hash does not match the row" };
      prev = r.hash;
      expectedSeq++;
    }
    return { ok: true, count: rows.length, head: prev };
  }
}
