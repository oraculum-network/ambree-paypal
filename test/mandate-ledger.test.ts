import { describe, expect, it } from "vitest";
import { canonicalJson, hashOf } from "../src/ledger/canonical.ts";
import { GENESIS, Ledger } from "../src/ledger/ledger.ts";
import { MANDATE_TTL_MS, Mandates, type Quote, quoteHash, view } from "../src/mandate/mandate.ts";
import { markWebhookSeen, openDb } from "../src/store/db.ts";

function clock(start = Date.parse("2026-11-05T08:00:00Z")) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

const QUOTE: Quote = {
  booking_id: "bk_1",
  guide_id: "g_tamarin",
  guide_name: "Tamarin Trails (sandbox)",
  activity: "hike",
  area: "Le Morne",
  date: "2026-11-05",
  party_size: 2,
  total: { currency_code: "EUR", value: "80.00" },
  deposit: { currency_code: "EUR", value: "30.00" },
  payee: { email_address: "tamarin-trails@business.sandbox.example" },
  guide_note: "Start 06:30 at the car park.",
  priced_at: "2026-11-04T10:00:00.000Z",
};

describe("canonical JSON", () => {
  it("sorts keys, drops undefined and normalises strings", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: undefined }] })).toBe('{"a":[true,null,{"d":"x"}],"b":1}');
    expect(canonicalJson("é")).toBe(canonicalJson("é"));
    expect(hashOf({ x: 1, y: 2 })).toBe(hashOf({ y: 2, x: 1 }));
  });

  it("refuses non-JSON values", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
  });

  it("the quote hash changes with any field", () => {
    const h = quoteHash(QUOTE);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(quoteHash({ ...QUOTE })).toBe(h);
    expect(quoteHash({ ...QUOTE, deposit: { currency_code: "EUR", value: "31.00" } })).not.toBe(h);
    expect(quoteHash({ ...QUOTE, payee: { email_address: "someone@else.example" } })).not.toBe(h);
    expect(quoteHash({ ...QUOTE, date: "2026-11-06" })).not.toBe(h);
  });
});

describe("ledger", () => {
  function filled() {
    const db = openDb();
    const c = clock();
    const ledger = new Ledger(db, c.now);
    ledger.append("bk_1", "quote.requested", { guide_id: "g1" });
    c.advance(1000);
    ledger.append("bk_1", "quote.priced", { deposit: "30.00" });
    ledger.append("bk_2", "quote.requested", { guide_id: "g2" });
    ledger.append("bk_1", "mandate.approved", { mandate_id: "md_1" });
    return { db, ledger };
  }

  it("chains rows from the genesis hash", () => {
    const { ledger } = filled();
    const all = ledger.list();
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(all[0]!.prev_hash).toBe(GENESIS);
    for (let i = 1; i < all.length; i++) expect(all[i]!.prev_hash).toBe(all[i - 1]!.hash);
    expect(ledger.list("bk_1").map((e) => e.kind)).toEqual(["quote.requested", "quote.priced", "mandate.approved"]);
    expect(ledger.verify()).toEqual({ ok: true, count: 4, head: all[3]!.hash });
  });

  it("an empty ledger verifies", () => {
    expect(new Ledger(openDb()).verify()).toEqual({ ok: true, count: 0, head: GENESIS });
  });

  it("detects an edited data field", () => {
    const { db, ledger } = filled();
    db.prepare("UPDATE ledger SET data = ? WHERE seq = 2").run(JSON.stringify({ deposit: "3.00" }));
    expect(ledger.verify()).toMatchObject({ ok: false, bad_seq: 2, reason: "hash does not match the row" });
  });

  it("detects a row whose hash was recomputed (the next row breaks)", () => {
    const { db, ledger } = filled();
    const row = ledger.list()[1]!;
    const forged = { ...row, data: { deposit: "3.00" } };
    const { hash: _old, ...base } = forged;
    const newHash = hashOf({ seq: base.seq, at: base.at, booking_id: base.booking_id, kind: base.kind, data: base.data, prev_hash: base.prev_hash });
    db.prepare("UPDATE ledger SET data = ?, hash = ? WHERE seq = 2").run(JSON.stringify(forged.data), newHash);
    expect(ledger.verify()).toMatchObject({ ok: false, bad_seq: 3, reason: "prev_hash does not match the previous row" });
  });

  it("detects a deleted row", () => {
    const { db, ledger } = filled();
    db.prepare("DELETE FROM ledger WHERE seq = 2").run();
    expect(ledger.verify()).toMatchObject({ ok: false, bad_seq: 3, reason: "expected seq 2" });
  });

  it("detects a changed kind or booking id", () => {
    const { db, ledger } = filled();
    db.prepare("UPDATE ledger SET kind = 'refund.completed' WHERE seq = 4").run();
    expect(ledger.verify()).toMatchObject({ ok: false, bad_seq: 4 });
  });

  it("detects corrupted JSON", () => {
    const { db, ledger } = filled();
    db.prepare("UPDATE ledger SET data = '{' WHERE seq = 1").run();
    expect(ledger.verify()).toMatchObject({ ok: false, bad_seq: 1, reason: "data is not JSON" });
  });

  it("dedupes webhook event ids", () => {
    const db = openDb();
    expect(markWebhookSeen(db, "WH-1", "PAYMENT.CAPTURE.COMPLETED", "t")).toBe(true);
    expect(markWebhookSeen(db, "WH-1", "PAYMENT.CAPTURE.COMPLETED", "t")).toBe(false);
  });
});

describe("mandate", () => {
  function setup() {
    const db = openDb();
    const c = clock();
    return { db, c, mandates: new Mandates(db, c.now) };
  }
  const pay = (q: Quote = QUOTE) => ({ quote: q, amount: q.deposit, payee: q.payee });

  it("pins amount, payee, quote hash, expiry and a nonce", () => {
    const { mandates } = setup();
    const { mandate, code } = mandates.propose(QUOTE);
    expect(code).toMatch(/^\d{6}$/);
    expect(mandate).toMatchObject({ booking_id: "bk_1", amount: QUOTE.deposit, payee: QUOTE.payee, quote_hash: quoteHash(QUOTE), status: "proposed", attempts: 0 });
    expect(mandate.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(Date.parse(mandate.expires_at) - Date.parse(mandate.created_at)).toBe(MANDATE_TTL_MS);
    expect(view(mandate)).not.toHaveProperty("step_up_hash");
  });

  it("never stores the step-up code in clear", () => {
    const { db, mandates } = setup();
    const { code } = mandates.propose(QUOTE);
    const rows = db.prepare("SELECT json FROM records").all() as Array<{ json: string }>;
    expect(rows.map((r) => r.json).join("")).not.toContain(`"${code}"`);
  });

  it("happy path: approve with the code, then consume once", () => {
    const { mandates } = setup();
    const { mandate, code } = mandates.propose(QUOTE);
    expect(mandates.consume(mandate.id, pay())).toMatchObject({ ok: false, reason: "not_approved" });
    expect(mandates.approve(mandate.id, code)).toMatchObject({ ok: true, value: { status: "approved" } });
    expect(mandates.approve(mandate.id, code)).toMatchObject({ ok: false, reason: "not_proposed" });
    const used = mandates.consume(mandate.id, pay());
    expect(used).toMatchObject({ ok: true, value: { status: "used" } });
    expect(mandates.consume(mandate.id, pay())).toMatchObject({ ok: false, reason: "used" });
  });

  it("locks after 5 wrong codes, even if the 6th is right", () => {
    const { mandates } = setup();
    const { mandate, code } = mandates.propose(QUOTE);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect(mandates.approve(mandate.id, wrong)).toMatchObject({ ok: false, reason: "wrong_code" });
    expect(mandates.approve(mandate.id, "abc")).toMatchObject({ ok: false, reason: "locked" });
    expect(mandates.approve(mandate.id, code)).toMatchObject({ ok: false, reason: "locked" });
    expect(mandates.get(mandate.id)?.status).toBe("locked");
  });

  it("expires before approval and before use", () => {
    const { mandates, c } = setup();
    const a = mandates.propose(QUOTE);
    c.advance(MANDATE_TTL_MS);
    expect(mandates.approve(a.mandate.id, a.code)).toMatchObject({ ok: false, reason: "expired" });
    expect(mandates.approve(a.mandate.id, a.code)).toMatchObject({ ok: false, reason: "expired" });
    const b = mandates.propose(QUOTE);
    expect(mandates.approve(b.mandate.id, b.code).ok).toBe(true);
    c.advance(MANDATE_TTL_MS + 1);
    expect(mandates.consume(b.mandate.id, pay())).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses a changed quote, amount or payee", () => {
    const { mandates } = setup();
    const { mandate, code } = mandates.propose(QUOTE);
    mandates.approve(mandate.id, code);
    expect(mandates.consume(mandate.id, pay({ ...QUOTE, guide_note: "changed" }))).toMatchObject({ ok: false, reason: "quote_changed" });
    expect(mandates.consume(mandate.id, { ...pay(), amount: { currency_code: "EUR", value: "300.00" } })).toMatchObject({ ok: false, reason: "amount_mismatch" });
    expect(mandates.consume(mandate.id, { ...pay(), payee: { email_address: "attacker@example.com" } })).toMatchObject({ ok: false, reason: "payee_mismatch" });
    expect(mandates.consume(mandate.id, { ...pay(), payee: { email_address: QUOTE.payee.email_address!.toUpperCase() } }).ok).toBe(true);
  });

  it("an unknown mandate is not_found", () => {
    const { mandates } = setup();
    expect(mandates.approve("md_nope", "123456")).toMatchObject({ ok: false, reason: "not_found" });
    expect(mandates.consume("md_nope", pay())).toMatchObject({ ok: false, reason: "not_found" });
  });
});
