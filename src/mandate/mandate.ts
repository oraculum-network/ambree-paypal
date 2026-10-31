// The traveller's mandate: the one thing that lets the agent prepare a payment. It pins the amount, the
// payee and the hash of the frozen quote, expires after 15 minutes, needs a 6-digit step-up code that
// only the traveller sees, and its nonce can be used once (it is also the create-order PayPal-Request-Id).

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { hashOf, sha256Hex } from "../ledger/canonical.ts";
import { sameMoney } from "../paypal/money.ts";
import type { Money, Payee } from "../paypal/types.ts";
import { type Db, Records } from "../store/db.ts";

export const MANDATE_TTL_MS = 15 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

export interface Quote {
  booking_id: string;
  guide_id: string;
  guide_name: string;
  activity: string;
  area: string;
  date: string;
  party_size: number;
  total: Money;
  deposit: Money;
  payee: Payee;
  guide_note: string;
  priced_at: string;
}

export type MandateStatus = "proposed" | "approved" | "used" | "locked" | "expired";

export interface Mandate {
  id: string;
  booking_id: string;
  amount: Money;
  payee: Payee;
  payee_name: string;
  quote_hash: string;
  nonce: string;
  created_at: string;
  expires_at: string;
  step_up_hash: string;
  attempts: number;
  status: MandateStatus;
  approved_at?: string;
  used_at?: string;
}

/** What the page may show: everything but the code's hash. */
export type MandateView = Omit<Mandate, "step_up_hash">;

export type MandateFailure = "not_found" | "not_proposed" | "not_approved" | "expired" | "locked" | "used" | "wrong_code" | "quote_changed" | "amount_mismatch" | "payee_mismatch";
export type MandateResult<T> = { ok: true; value: T } | { ok: false; reason: MandateFailure; message: string };

export function quoteHash(q: Quote): string {
  return hashOf(q);
}

export function samePayee(a: Payee, b: Payee): boolean {
  if (a.email_address !== undefined || b.email_address !== undefined) return (a.email_address ?? "").toLowerCase() === (b.email_address ?? "").toLowerCase();
  return a.merchant_id === b.merchant_id;
}

function codeHash(mandateId: string, code: string): string {
  return sha256Hex(`${mandateId}:${code}`);
}

export function view(m: Mandate): MandateView {
  const { step_up_hash: _hidden, ...rest } = m;
  return rest;
}

const MESSAGES: Record<MandateFailure, string> = {
  not_found: "No such mandate.",
  not_proposed: "This mandate is no longer waiting for approval.",
  not_approved: "The traveller has not approved this mandate.",
  expired: "The mandate expired; propose a new one.",
  locked: "Too many wrong codes; the mandate is locked. Propose a new one.",
  used: "The mandate was already used (its nonce is single-use).",
  wrong_code: "That code is not right.",
  quote_changed: "The quote changed after the mandate was approved.",
  amount_mismatch: "The amount differs from the approved mandate.",
  payee_mismatch: "The payee differs from the approved mandate.",
};

function fail<T>(reason: MandateFailure): MandateResult<T> {
  return { ok: false, reason, message: MESSAGES[reason] };
}

export class Mandates {
  readonly #records: Records<Mandate>;
  readonly #now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.#records = new Records<Mandate>(db, "mandate");
    this.#now = now;
  }

  get(id: string): Mandate | undefined {
    return this.#records.get(id);
  }

  /** A new mandate for a frozen quote. The code is returned once, for the traveller's channel only. */
  propose(quote: Quote): { mandate: Mandate; code: string } {
    const now = this.#now();
    const id = `md_${randomBytes(8).toString("hex")}`;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const mandate: Mandate = {
      id,
      booking_id: quote.booking_id,
      amount: quote.deposit,
      payee: quote.payee,
      payee_name: quote.guide_name,
      quote_hash: quoteHash(quote),
      nonce: randomBytes(16).toString("hex"),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + MANDATE_TTL_MS).toISOString(),
      step_up_hash: codeHash(id, code),
      attempts: 0,
      status: "proposed",
    };
    this.#records.put(mandate);
    return { mandate, code };
  }

  #expired(m: Mandate): boolean {
    return this.#now().getTime() >= Date.parse(m.expires_at);
  }

  /** The traveller approves with the step-up code. */
  approve(id: string, code: string): MandateResult<Mandate> {
    const m = this.#records.get(id);
    if (!m) return fail("not_found");
    if (m.status === "locked") return fail("locked");
    if (m.status !== "proposed") return fail(m.status === "expired" ? "expired" : "not_proposed");
    if (this.#expired(m)) {
      this.#records.put({ ...m, status: "expired" });
      return fail("expired");
    }
    const given = Buffer.from(codeHash(id, /^\d{6}$/.test(code) ? code : "x"));
    const want = Buffer.from(m.step_up_hash);
    if (!timingSafeEqual(given, want)) {
      const attempts = m.attempts + 1;
      this.#records.put({ ...m, attempts, status: attempts >= MAX_CODE_ATTEMPTS ? "locked" : "proposed" });
      return fail(attempts >= MAX_CODE_ATTEMPTS ? "locked" : "wrong_code");
    }
    return { ok: true, value: this.#records.put({ ...m, status: "approved", approved_at: this.#now().toISOString() }) };
  }

  /**
   * Spends the mandate: checks it against what is about to be paid, then marks the nonce used.
   * Synchronous, so two callers can't both pass the check.
   */
  consume(id: string, payment: { quote: Quote; amount: Money; payee: Payee }): MandateResult<Mandate> {
    const m = this.#records.get(id);
    if (!m) return fail("not_found");
    if (m.status === "used") return fail("used");
    if (m.status === "locked") return fail("locked");
    if (m.status !== "approved") return fail(m.status === "expired" ? "expired" : "not_approved");
    if (this.#expired(m)) {
      this.#records.put({ ...m, status: "expired" });
      return fail("expired");
    }
    if (quoteHash(payment.quote) !== m.quote_hash) return fail("quote_changed");
    if (!sameMoney(payment.amount, m.amount)) return fail("amount_mismatch");
    if (!samePayee(payment.payee, m.payee)) return fail("payee_mismatch");
    return { ok: true, value: this.#records.put({ ...m, status: "used", used_at: this.#now().toISOString() }) };
  }
}
