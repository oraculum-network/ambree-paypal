// Monday's spike: one real sandbox order whose payee is another sandbox account, end to end.
//
//   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node scripts/spike.ts --payee-email guide@business.example.com
//
// (a) OAuth token, (b) a CAPTURE order of 10.00 with purchase_units[0].payee, (c) the approve link, then polls
// GET /v2/checkout/orders/{id} until APPROVED, (d) captures, (e) the refund-premise sequence on the captured
// amount A (DESIGN.md §5 S12): e1 refunds 1.00, e2 repeats it with the same PayPal-Request-Id, e3 reads e1
// back, e4 refunds the rest, e4b reads e1 again, e5 asks 1.00 more of the fully refunded capture (a refusal
// is expected), e6 repeats e4's request; (f) a table of HTTP statuses and ids, and the premise block. It never prints a
// secret, a token or the client id, refuses any base URL but the sandbox, and never lets PayPal refund more
// than A (RefundBudget). Its client sends each write once (spikeClient), so every refund call is one
// exchange and a lost reply is "no answer". It answers DESIGN.md §5 S1-S6, S9, S11 and S12. PAYPAL_WEBHOOK_ID
// is not needed.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type PayPalClientOptions, PayPalRestClient } from "../src/paypal/client.ts";
import { PayPalError } from "../src/paypal/errors.ts";
import { formatMoney, isCurrency, money, toMinor } from "../src/paypal/money.ts";
import { assertSandboxBase } from "../src/paypal/sandbox.ts";
import type { PaymentsApi } from "../src/paypal/api.ts";
import { type Capture, type CreateOrderRequest, type CurrencyCode, type Money, type Order, type Payee, type Refund, type RefundRequest, approveLink, firstCapture } from "../src/paypal/types.ts";

export interface SpikeArgs {
  payee: Payee;
  currency: CurrencyCode;
  value: string;
  timeoutSec: number;
  pollSec: number;
  refund: boolean;
  paymentSource: boolean;
}

export const USAGE =
  "usage: node scripts/spike.ts (--payee-email EMAIL | --payee-merchant-id ID) [--currency EUR|USD] [--amount 10.00] [--timeout 600] [--poll 5] [--no-refund] [--with-payment-source]";

export function parseArgs(argv: string[]): SpikeArgs {
  const out: SpikeArgs = { payee: undefined as unknown as Payee, currency: "EUR", value: "10.00", timeoutSec: 600, pollSec: 5, refund: true, paymentSource: false };
  let email: string | undefined;
  let merchant: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`);
      return v;
    };
    switch (flag) {
      case "--payee-email":
        email = next();
        break;
      case "--payee-merchant-id":
        merchant = next();
        break;
      case "--currency": {
        const c = next().toUpperCase();
        if (c !== "EUR" && c !== "USD") throw new Error(`--currency must be EUR or USD\n${USAGE}`);
        out.currency = c;
        break;
      }
      case "--amount": {
        const v = next();
        if (!/^\d{1,4}\.\d{2}$/.test(v)) throw new Error(`--amount must look like 10.00\n${USAGE}`);
        out.value = v;
        break;
      }
      case "--timeout":
        out.timeoutSec = positiveInt(flag, next());
        break;
      case "--poll":
        out.pollSec = positiveInt(flag, next());
        break;
      case "--no-refund":
        out.refund = false;
        break;
      case "--with-payment-source":
        out.paymentSource = true;
        break;
      default:
        throw new Error(`unknown argument ${flag.slice(0, 40)}\n${USAGE}`);
    }
  }
  if ((email ? 1 : 0) + (merchant ? 1 : 0) !== 1) throw new Error(`give exactly one of --payee-email or --payee-merchant-id\n${USAGE}`);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--payee-email is not an email address");
  if (merchant && !/^[A-Z0-9]{8,20}$/.test(merchant)) throw new Error("--payee-merchant-id should be the 13-character PayPal merchant id");
  out.payee = email ? { email_address: email } : { merchant_id: merchant! };
  return out;
}

function positiveInt(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive whole number of seconds`);
  return n;
}

/** Reads the credentials by name. Errors name the variable only. */
export function readEnv(env: Record<string, string | undefined>): { clientId: string; clientSecret: string; baseUrl: string } {
  const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`set ${missing.join(" and ")} (sandbox REST app credentials)`);
  return { clientId: env.PAYPAL_CLIENT_ID!, clientSecret: env.PAYPAL_CLIENT_SECRET!, baseUrl: assertSandboxBase(env.PAYPAL_BASE_URL) };
}

export function buildOrder(a: SpikeArgs, runId: string): CreateOrderRequest {
  const body: CreateOrderRequest = {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: `spike-${runId}`,
        custom_id: `spike-${runId}`,
        invoice_id: `AMB-SPIKE-${runId}`,
        description: "Ambree spike: guide deposit (sandbox)",
        amount: { currency_code: a.currency, value: a.value },
        payee: a.payee,
      },
    ],
  };
  if (a.paymentSource) {
    body.payment_source = {
      paypal: { experience_context: { return_url: "https://example.com/ambree-spike/return", cancel_url: "https://example.com/ambree-spike/cancel", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", brand_name: "Ambree (sandbox)" } },
    };
  }
  return body;
}

export interface Row {
  step: string;
  call: string;
  status: string;
  id: string;
  note: string;
}

export function formatTable(rows: Row[]): string {
  const head: Row = { step: "step", call: "call", status: "HTTP", id: "id", note: "note" };
  const all = [head, ...rows];
  const keys = Object.keys(head) as Array<keyof Row>;
  const width = Object.fromEntries(keys.map((k) => [k, Math.max(...all.map((r) => r[k].length))])) as Record<keyof Row, number>;
  const line = (r: Row) => keys.map((k) => r[k].padEnd(width[k])).join(" | ").trimEnd();
  return [line(head), keys.map((k) => "-".repeat(width[k])).join("-|-"), ...rows.map(line)].join("\n");
}

/** Drops anything that looks like a token or a Basic/Bearer header from text we print. */
export function scrub(text: string): string {
  return text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]").replace(/\bA21AA[A-Za-z0-9._-]+/g, "[token]");
}

/**
 * scrub, after replacing the credentials' literal values (8 characters or more: a shorter one would garble
 * the text). Every line the CLI prints goes through it, so neither the client id nor the secret is printed.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const v of secrets) if (v.length >= 8) out = out.split(v).join("[redacted]");
  return scrub(out);
}

export interface SpikeDeps {
  api: PaymentsApi;
  args: SpikeArgs;
  runId: string;
  print: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** The HTTP status of the last call (spikeClient's lastStatus). */
  lastStatus: () => number;
  /**
   * How many refund POST exchanges (REFUND_CALL) PayPal may have acted on so far (spikeClient's refundPosts:
   * a 401 isn't one). The money guard counts every exchange that may have made a refund.
   */
  refundPosts: () => number;
}

/**
 * The spike's client sends a write once: a refund POST is then exactly one exchange, so the client's own
 * resend never mixes into the dedupe experiment (P1) or makes a refund the spike can't see (P5). A lost reply
 * is reported as "no answer" instead.
 */
export const SPIKE_WRITE_RETRIES = 0;

export interface SpikeClient {
  client: PayPalRestClient;
  /** The HTTP status of the last exchange. */
  lastStatus: () => number;
  /**
   * Refund POST exchanges PayPal may have acted on. A 401 isn't one: PayPal refused the token without acting,
   * and the client sends the request again with a new token.
   */
  refundPosts: () => number;
}

/** The spike's PayPal client (writeRetries SPIKE_WRITE_RETRIES) and its onCall counters. main and the tests build it here. */
export function spikeClient(opts: Omit<PayPalClientOptions, "onCall" | "writeRetries">): SpikeClient {
  let last = 0;
  let refundPosts = 0;
  const client = new PayPalRestClient({
    ...opts,
    writeRetries: SPIKE_WRITE_RETRIES,
    onCall: (c) => {
      last = c.status;
      if (c.call === REFUND_CALL && c.status !== 401) refundPosts++;
    },
  });
  return { client, lastStatus: () => last, refundPosts: () => refundPosts };
}

function describeError(e: unknown): string {
  return e instanceof PayPalError ? e.summary() : e instanceof Error ? e.message : "unknown error";
}

/**
 * Runs (b)-(e). Returns the rows, whether every step that ran succeeded (for (e), every planned call ran:
 * refundOk), and what the refund sequence saw, for the premise block.
 */
export async function runSpike(d: SpikeDeps): Promise<{ rows: Row[]; ok: boolean; refunds?: RefundRun }> {
  const rows: Row[] = [];
  const status = () => String(d.lastStatus() || "-");
  const fail = (step: string, call: string, e: unknown) => {
    rows.push({ step, call, status: e instanceof PayPalError ? String(e.status || e.kind) : "-", id: "", note: scrub(describeError(e)) });
    return { rows, ok: false };
  };

  let order: Order;
  try {
    order = await d.api.createOrder(buildOrder(d.args, d.runId), `spike-create-${d.runId}`);
  } catch (e) {
    return fail("b create", "POST /v2/checkout/orders", e);
  }
  const payee = order.purchase_units?.[0]?.payee;
  rows.push({ step: "b create", call: "POST /v2/checkout/orders", status: status(), id: order.id, note: `status ${order.status}; payee echoed ${JSON.stringify(payee ?? null)}; links ${(order.links ?? []).map((l) => l.rel).join(",")}` });
  const link = approveLink(order);
  if (!link) {
    rows.push({ step: "c approve", call: "-", status: "-", id: order.id, note: "no approve or payer-action link" });
    return { rows, ok: false };
  }
  d.print(`\nApprove the order as the sandbox BUYER (personal account) in a browser:\n  ${link}\nPolling every ${d.args.pollSec}s for up to ${d.args.timeoutSec}s…`);

  const deadline = Date.now() + d.args.timeoutSec * 1000;
  let polls = 0;
  for (;;) {
    try {
      order = await d.api.getOrder(order.id);
      polls++;
    } catch (e) {
      return fail("c poll", "GET /v2/checkout/orders/{id}", e);
    }
    if (order.status === "APPROVED") break;
    if (Date.now() >= deadline) {
      rows.push({ step: "c poll", call: "GET /v2/checkout/orders/{id}", status: status(), id: order.id, note: `timed out at status ${order.status} after ${polls} polls` });
      return { rows, ok: false };
    }
    await d.sleep(d.args.pollSec * 1000);
  }
  rows.push({ step: "c poll", call: "GET /v2/checkout/orders/{id}", status: status(), id: order.id, note: `APPROVED after ${polls} polls; payer ${order.payer?.payer_id ?? "?"}` });

  let capture;
  try {
    const captured = await d.api.captureOrder(order.id, `spike-capture-${d.runId}`);
    capture = firstCapture(captured);
    rows.push({ step: "d capture", call: "POST /v2/checkout/orders/{id}/capture", status: status(), id: capture?.id ?? "(none)", note: `order ${captured.status}; capture ${capture?.status ?? "?"}; custom_id ${capture?.custom_id ?? "(absent)"}` });
  } catch (e) {
    return fail("d capture", "POST /v2/checkout/orders/{id}/capture", e);
  }
  if (!capture) return { rows, ok: false };

  if (!d.args.refund) {
    rows.push({ step: "e refund", call: "-", status: "-", id: "", note: "skipped (--no-refund)" });
    return { rows, ok: true };
  }
  const refunds = await runRefundPremises(d, capture);
  rows.push(...refundRows(refunds));
  return { rows, ok: refundOk(refunds), refunds };
}

// ---------- (e) the refund premises (DESIGN.md §5 S12; §19 "Verify in spike S11"; §20) ----------

export const REFUND_CALL = "POST /v2/payments/captures/{id}/refund";
const GET_REFUND_CALL = "GET /v2/payments/refunds/{id}";
/** e1's 1.00, plus a duplicate of it if PayPal doesn't dedupe e2, must fit in A. */
const MIN_A_MINOR = 200;
const STEP_MINOR = 100;

/** A refund the spike asks for: always with an amount, so the guard can weigh it. */
type AmountRefund = RefundRequest & { amount: Money };

/** One call of the sequence, as the rows and the premise answers read it. */
export interface RefundCall {
  /** The reply's HTTP status; 0 when none came back or nothing was sent. */
  http: number;
  /** How many refund POST exchanges it took (spikeClient's count; 1 unless the client resent it). */
  exchanges?: number;
  /** The reply, on a 2xx. */
  refund?: Refund;
  /** What went wrong otherwise. `issues` is every details[].issue PayPal returned. */
  error?: { kind: string; issues: readonly string[]; summary: string; maybeDelivered: boolean };
  /** Not sent because the plan doesn't need it (A is already refunded, or e4 wasn't sent). Still ok. */
  skipped?: string;
  /** Not sent because the money guard refused it. Not ok. */
  guard?: string;
}

/** Everything the sequence saw. Its rows, its premise block and whether it is ok are pure functions of this. */
export interface RefundRun {
  captureId: string;
  /** A: the captured amount, from the capture reply. */
  captured: Money;
  /** The custom_id every refund of the run is sent with: "spike-<runId>". */
  customId: string;
  /** Set when the sequence didn't start, and why. */
  refused?: string;
  e1?: RefundCall;
  e2?: RefundCall;
  e3?: RefundCall;
  e4?: RefundCall;
  /** e1 read again after e4 (P5: does GET show the running total?). Informational: not part of refundOk. */
  e4b?: RefundCall;
  e5?: RefundCall;
  e6?: RefundCall;
}

export class RefundGuardRefused extends Error {
  override name = "RefundGuardRefused";
  /** The step the guard kept from being sent. */
  readonly step: string;
  constructor(step: string, message: string) {
    super(message);
    this.step = step;
  }
}

/**
 * The money guard: this run never lets PayPal refund more than A on the capture.
 * - Before a POST that may make a new refund (e1, e2, e4): what PayPal may already have refunded (the worst
 *   case) plus the amount asked stays within A. e2 counts as new, since its dedupe is what is being asked.
 * - Before a refusal probe (e5, e6): PayPal's own replies already show all of A refunded (distinct refund
 *   ids, not FAILED or CANCELLED, each counted at no more than was asked). The probe asks beyond A on
 *   purpose; PayPal can only refuse it or replay an earlier reply, as the capture holds nothing more.
 * The spike's client sends a refund POST once (SPIKE_WRITE_RETRIES), so a POST is one exchange. assertRoom
 * reserves the amount for every exchange a POST may take (exchangesPerPost), and record counts the amount
 * once for every exchange that may have reached PayPal. The one exchange not counted is the last, when it was
 * answered with a refusal or with a refund id already counted.
 */
export class RefundBudget {
  #worst = 0;
  #confirmed = 0;
  readonly #ids = new Set<string>();
  /** A, in minor units. */
  readonly capturedMinor: number;
  /** A's currency (only for the messages; the amounts are minor units of it). */
  readonly currency: CurrencyCode;
  /** The most exchanges one refund POST can take: 1 + the client's writeRetries (the spike's client: 1). */
  readonly exchangesPerPost: number;

  constructor(capturedMinor: number, currency: CurrencyCode = "EUR", exchangesPerPost = 1) {
    if (!Number.isInteger(exchangesPerPost) || exchangesPerPost < 1) throw new RangeError("exchangesPerPost must be a whole number, 1 or more");
    this.capturedMinor = capturedMinor;
    this.currency = currency;
    this.exchangesPerPost = exchangesPerPost;
  }

  /** What PayPal may have refunded because of this run, in the worst case. */
  get worstMinor(): number {
    return this.#worst;
  }

  /** What PayPal's replies show refunded (or held, PENDING) by this run's distinct refunds. */
  get confirmedMinor(): number {
    return this.#confirmed;
  }

  /** Throws unless PayPal honouring `minor` on every exchange the POST may take keeps the worst case within A. */
  assertRoom(step: string, minor: number): void {
    if (!Number.isSafeInteger(minor) || minor <= 0) throw new RefundGuardRefused(step, "not a positive amount");
    const n = this.exchangesPerPost;
    if (this.#worst + minor * n > this.capturedMinor) {
      const more = n > 1 ? `${this.#fmt(minor)} on each of ${n} exchanges` : this.#fmt(minor);
      throw new RefundGuardRefused(step, `PayPal may already have refunded ${this.#fmt(this.#worst)} of A (${this.#fmt(this.capturedMinor)}); another ${more} could take the capture past A`);
    }
  }

  /** Throws unless PayPal's own replies already account for all of A (a probe can then move no money). */
  assertFull(step: string): void {
    if (this.#confirmed < this.capturedMinor) {
      throw new RefundGuardRefused(step, `PayPal's replies show ${this.#fmt(this.#confirmed)} of A (${this.#fmt(this.capturedMinor)}) refunded, so this probe could still move money`);
    }
  }

  /** Counts a POST's outcome. `attempts` is how many refund exchanges it took (at least 1). */
  record(askedMinor: number, attempts: number, c: RefundCall): void {
    const n = Math.max(1, attempts);
    let counted = 0;
    if (c.refund) {
      if (this.#ids.has(c.refund.id)) counted = n - 1;
      else {
        counted = n;
        this.#ids.add(c.refund.id);
        if (c.refund.status !== "FAILED" && c.refund.status !== "CANCELLED") this.#confirmed += Math.min(minorIn(c.refund.amount, this.currency) ?? askedMinor, askedMinor);
      }
    } else if (c.error?.maybeDelivered) {
      counted = c.http >= 400 && c.http < 500 ? n - 1 : n;
    }
    this.#worst += askedMinor * counted;
  }

  #fmt(minor: number): string {
    return formatMoney(money(this.currency, minor));
  }
}

function minorIn(m: Money | undefined, currency: CurrencyCode): number | undefined {
  if (!m || m.currency_code !== currency) return undefined;
  try {
    return toMinor(String(m.value));
  } catch {
    return undefined;
  }
}

function fmtMoney(m: Money): string {
  try {
    return formatMoney(m);
  } catch {
    return `${String(m.currency_code).slice(0, 3)} ${String(m.value).slice(0, 20)}`;
  }
}

function callFromError(e: unknown): RefundCall {
  if (e instanceof PayPalError) return { http: e.status, error: { kind: e.kind, issues: e.issues, summary: scrub(e.summary()), maybeDelivered: e.maybeDelivered } };
  return { http: 0, error: { kind: "error", issues: [], summary: scrub(e instanceof Error ? e.message : "unknown error"), maybeDelivered: true } };
}

/** e1-e6 on the capture. Stops after e1 if e1 made no refund. Every refund POST passes the guard first. */
async function runRefundPremises(d: SpikeDeps, capture: Capture): Promise<RefundRun> {
  const run: RefundRun = { captureId: capture.id, captured: capture.amount, customId: `spike-${d.runId}` };
  const a = capture.amount;
  let capturedMinor: number;
  try {
    if (!a || !isCurrency(a.currency_code)) throw new RangeError("no amount");
    capturedMinor = toMinor(String(a.value));
  } catch {
    run.refused = "the capture reply carries no amount the spike can read";
    return run;
  }
  if (capturedMinor < MIN_A_MINOR) {
    run.refused = `the capture is ${formatMoney(a)}; the premise sequence needs at least 2.00 (e1's 1.00 plus a possible duplicate). Rerun with --amount 2.00 or more`;
    return run;
  }
  const currency = a.currency_code;
  const budget = new RefundBudget(capturedMinor, currency, 1 + SPIKE_WRITE_RETRIES);
  const body = (minor: number): AmountRefund => ({ amount: money(currency, minor), custom_id: run.customId, note_to_payer: "Ambree spike: refund premises (sandbox)" });

  const post = async (step: string, b: AmountRefund, requestId: string, kind: "room" | "probe"): Promise<RefundCall> => {
    const minor = toMinor(b.amount.value);
    try {
      if (kind === "room") budget.assertRoom(step, minor);
      else budget.assertFull(step);
    } catch (e) {
      if (e instanceof RefundGuardRefused) return { http: 0, guard: e.message };
      throw e;
    }
    const before = d.refundPosts();
    let c: RefundCall;
    try {
      const refund = await d.api.refundCapture(capture.id, b, requestId);
      c = { http: d.lastStatus(), refund };
    } catch (e) {
      c = callFromError(e);
    }
    c.exchanges = d.refundPosts() - before;
    budget.record(minor, c.exchanges, c);
    return c;
  };

  // e1: 1.00, then e2: the very same POST (body and request id).
  const b1 = body(STEP_MINOR);
  const id1 = `spike-refund1-${d.runId}`;
  run.e1 = await post("e1", b1, id1, "room");
  const r1 = run.e1.refund;
  if (!r1) return run;
  run.e2 = await post("e2", b1, id1, "room");

  const get = async (refundId: string): Promise<RefundCall> => {
    try {
      const refund = await d.api.getRefund(refundId);
      return { http: d.lastStatus(), refund };
    } catch (e) {
      return callFromError(e);
    }
  };

  // e3: e1 read back.
  run.e3 = await get(r1.id);

  // e4: the rest of A (less e2's 1.00 if PayPal may have made it a second refund, or e2's reply was lost).
  const rest = Math.floor((capturedMinor - budget.worstMinor) / budget.exchangesPerPost);
  const id2 = `spike-refund2-${d.runId}`;
  let b4: AmountRefund | undefined;
  if (rest <= 0) {
    run.e4 =
      budget.worstMinor === budget.confirmedMinor
        ? { http: 0, skipped: `e1 and e2 already refunded all of A (${formatMoney(a)})` }
        : { http: 0, guard: `PayPal may already have refunded all of A (${formatMoney(a)}), counting replies that were lost` };
  } else {
    b4 = body(rest);
    run.e4 = await post("e4", b4, id2, "room");
  }
  // e4b: e1 read again, now that e4 has refunded the rest: does GET show the running total, or the total
  // from when e1 was made (P5)? Read-only, so it is sent whenever e4 was.
  run.e4b = b4 && !run.e4.guard ? await get(r1.id) : { http: 0, skipped: "e4 wasn't sent" };

  // e5: 1.00 more of the fully refunded capture, under a new request id; e6: e4's request again.
  run.e5 = await post("e5", body(STEP_MINOR), `spike-refund3-${d.runId}`, "probe");
  run.e6 = b4 ? await post("e6", b4, id2, "probe") : { http: 0, skipped: "e4 wasn't sent" };
  return run;
}

const STEPS = [
  ["e1", "e1 refund", REFUND_CALL],
  ["e2", "e2 dedupe", REFUND_CALL],
  ["e3", "e3 get", GET_REFUND_CALL],
  ["e4", "e4 rest", REFUND_CALL],
  ["e4b", "e4b get", GET_REFUND_CALL],
  ["e5", "e5 refusal", REFUND_CALL],
  ["e6", "e6 replay", REFUND_CALL],
] as const;
type StepKey = (typeof STEPS)[number][0];

const is4xx = (c: RefundCall) => c.http >= 400 && c.http < 500;
/** A 4xx PayPal answered without any earlier attempt of the call having maybe reached it. */
const answered4xx = (c: RefundCall) => is4xx(c) && !c.error?.maybeDelivered;
const isGet = (key: StepKey) => key === "e3" || key === "e4b";

/**
 * Why a call has no answer. A refund POST whose reply was lost (a network error, a timeout or a 5xx), or
 * refused after an earlier attempt's reply was lost, may have refunded.
 */
function noAnswer(c: RefundCall, post: boolean): string {
  const e = c.error;
  if (e?.maybeDelivered) {
    if (!post) return "no answer (the reply was lost)";
    return is4xx(c) ? "no answer (an earlier attempt's reply may have been lost; PayPal may have refunded)" : "no answer (the reply may have been lost; PayPal may have refunded)";
  }
  return `no answer (${e?.summary ?? "nothing came back"})`;
}

/**
 * A refund POST (e1, e2, e4) that may have made a refund its reply doesn't show: no reply came back, or the
 * call took more than one exchange.
 */
function mayHideRefund(c: RefundCall | undefined): boolean {
  if (!c || c.skipped || c.guard) return false;
  if ((c.exchanges ?? 1) > 1) return true;
  return !c.refund && (!c.error || c.error.maybeDelivered);
}

/** The first of e1, e2 and e4 that may have made a refund the spike never saw: P5's sums are then unknown. */
function hiddenRefundAt(run: RefundRun): string | undefined {
  return (["e1", "e2", "e4"] as const).find((k) => mayHideRefund(run[k]));
}
const amountOf = (r: Refund) => (r.amount ? fmtMoney(r.amount) : "amount absent");
const totalOf = (r: Refund) => {
  const t = r.seller_payable_breakdown?.total_refunded_amount;
  return t ? fmtMoney(t) : "absent";
};
const customIdOf = (r: Refund, run: RefundRun) => (r.custom_id === run.customId ? "yes" : r.custom_id === undefined ? "no (absent)" : `other (${String(r.custom_id).slice(0, 40)})`);

/**
 * Whether the refund's links[rel=up] names this capture, read as the service's refundCaptureId reads it
 * (src/booking/service.ts; kept in step by hand): the first `up` link whose path is
 * /v2/payments/captures/{id}. Otherwise the first `up` link's path is shown.
 */
function upLinkOf(r: Refund, run: RefundRun): string {
  const ups = (Array.isArray(r.links) ? r.links : []).filter((l) => l && l.rel === "up" && typeof l.href === "string");
  if (!ups.length) return "no (absent)";
  let other: string | undefined;
  for (const l of ups) {
    let path: string;
    try {
      path = new URL(l.href).pathname;
    } catch {
      other ??= "not a URL";
      continue;
    }
    const m = /^\/v2\/payments\/captures\/([^/]+)\/?$/.exec(path);
    if (m) {
      let id: string | undefined;
      try {
        id = decodeURIComponent(m[1]!);
      } catch {
        id = undefined;
      }
      return id === run.captureId ? "yes" : `other (${path.slice(0, 80)})`;
    }
    other ??= path.slice(0, 80);
  }
  return `other (${other})`;
}

function errorNote(c: RefundCall): string {
  const e = c.error!;
  return `${e.summary}; issues ${e.issues.join(", ") || "none"}`;
}

function noteOf(key: StepKey, c: RefundCall, run: RefundRun): string {
  if (c.skipped) return `not needed: ${c.skipped}`;
  if (c.guard) return `not sent: ${c.guard}`;
  const r = c.refund;
  if (!r) {
    const e = c.error!;
    if (e.maybeDelivered && !isGet(key)) return `${noAnswer(c, true)}: ${errorNote(c)}`;
    if (key === "e5" && is4xx(c)) return `refused as expected: HTTP ${c.http}; issues ${e.issues.join(", ") || "none"}; ${e.summary}`;
    if (key === "e6" && is4xx(c)) return `refused: HTTP ${c.http}; issues ${e.issues.join(", ") || "none"}; ${e.summary}`;
    return errorNote(c);
  }
  switch (key) {
    case "e1":
      return `${r.status}; ${amountOf(r)}; custom_id echoed ${customIdOf(r, run)}; up link names this capture ${upLinkOf(r, run)}; total_refunded_amount ${totalOf(r)}`;
    case "e2":
      return r.id === run.e1?.refund?.id ? "DEDUPED (same refund id)" : `NOT DEDUPED (new refund id ${r.id}, ${r.status}, ${amountOf(r)})`;
    case "e3":
      return `${r.status}; custom_id ${customIdOf(r, run)}; up link names this capture ${upLinkOf(r, run)}; total_refunded_amount ${totalOf(r)}`;
    case "e4": {
      const t = r.seller_payable_breakdown?.total_refunded_amount;
      const cur = run.captured.currency_code;
      const isA = !t ? "" : minorIn(t, cur) === minorIn(run.captured, cur) ? " (= A: yes)" : ` (= A: no, A is ${fmtMoney(run.captured)})`;
      return `${r.status}; ${amountOf(r)}; total_refunded_amount ${totalOf(r)}${isA}`;
    }
    case "e4b":
      return `${r.status}; total_refunded_amount ${totalOf(r)}`;
    case "e5":
      return `UNEXPECTED: PayPal accepted it (refund ${r.id}, ${r.status}, ${amountOf(r)})`;
    case "e6":
      return r.id === run.e4?.refund?.id ? "DEDUPED (same refund id as e4)" : `NOT DEDUPED (new refund id ${r.id}, ${r.status}, ${amountOf(r)}): UNEXPECTED on a fully refunded capture`;
  }
}

/** The table rows for (e). */
export function refundRows(run: RefundRun): Row[] {
  if (run.refused) return [{ step: "e refund", call: "-", status: "-", id: "", note: scrub(`refused: ${run.refused}`) }];
  const rows: Row[] = [];
  for (const [key, step, call] of STEPS) {
    const c = run[key];
    if (!c) continue;
    const status = c.refund ? String(c.http || "-") : c.error ? String(c.http || c.error.kind) : "-";
    rows.push({ step, call, status, id: c.refund?.id ?? "", note: scrub(noteOf(key, c, run)) });
  }
  return rows;
}

/**
 * The run is ok when every planned call ran and answered as a step can: e1-e4 with a refund (e2 deduped or
 * not; e4 may be not needed), e5 with a 4xx, e6 with e4's refund or a 4xx (or not needed when e4 wasn't).
 */
export function refundOk(run: RefundRun): boolean {
  if (run.refused) return false;
  const { e1, e2, e3, e4, e5, e6 } = run;
  if (!e1?.refund || !e2?.refund || !e3?.refund || !e4 || !e5 || !e6) return false;
  if (!e4.refund && !e4.skipped) return false;
  if (!(e5.error && answered4xx(e5))) return false;
  if (e6.skipped) return Boolean(e4.skipped);
  if (e6.refund) return e6.refund.id === e4.refund?.id;
  return Boolean(e6.error && answered4xx(e6));
}

type RepeatKind = "same" | "new" | "refused" | "error" | "notsent" | "notrun";

function repeatAnswer(c: RefundCall | undefined, firstId: string | undefined, sameText: string): { kind: RepeatKind; text: string } {
  if (!c) return { kind: "notrun", text: "not run" };
  if (c.skipped) return { kind: "notrun", text: `not run (${c.skipped})` };
  if (c.guard) return { kind: "notsent", text: `not sent (${c.guard})` };
  if (c.refund) return c.refund.id === firstId ? { kind: "same", text: `DEDUPED (${sameText})` } : { kind: "new", text: `NOT DEDUPED (new refund id ${c.refund.id})` };
  if (answered4xx(c)) return { kind: "refused", text: `refused (HTTP ${c.http} ${c.error!.issues.join(", ") || "with no issue names"})` };
  return { kind: "error", text: noAnswer(c, true) };
}

function dedupeVerdict(e2: RepeatKind, e6: RepeatKind): string {
  if (e2 === "new") return "NO: the repeat made a second refund";
  if (e2 === "refused") return "NO: PayPal refused the repeat rather than replaying it";
  if (e2 !== "same") return "unanswered";
  if (e6 === "same") return "yes: a repeated PayPal-Request-Id replays the first reply, also once the capture is fully refunded";
  if (e6 === "refused") return "yes while the capture has room; once it is fully refunded the repeat is refused, not replayed";
  if (e6 === "new") return "yes for e2, but e6's repeat made a new refund";
  return "yes for e2; e6 unanswered";
}

function refusalAnswer(c: RefundCall | undefined, replayOf: string | undefined): string {
  if (!c) return "not run";
  if (c.skipped) return `not run (${c.skipped})`;
  if (c.guard) return `not sent (${c.guard})`;
  if (c.refund) return replayOf !== undefined && c.refund.id === replayOf ? "replayed (same refund id as e4), not refused" : `ACCEPTED (refund id ${c.refund.id}): UNEXPECTED`;
  if (!answered4xx(c)) return noAnswer(c, true);
  const issues = c.error!.issues;
  if (!issues.length) return `HTTP ${c.http} with no issue names`;
  return `HTTP ${c.http} ${issues.join(", ")}${issues.length > 1 ? ` (the service reads only the first, ${issues[0]})` : ""}`;
}

/**
 * The distinct refunds e1, e2 and e4 made, as their replies show them (FAILED and CANCELLED ones count 0):
 * their sum, whether every amount was readable, and the last one with the sum up to it.
 */
function refundsSeen(run: RefundRun): { sum: number; readable: boolean; last?: { label: string; refund: Refund; sum: number } } {
  const currency = run.captured.currency_code;
  const ids = new Set<string>();
  let sum = 0;
  let readable = true;
  let last: { label: string; refund: Refund; sum: number } | undefined;
  for (const [label, c] of [["e1", run.e1], ["e2", run.e2], ["e4", run.e4]] as const) {
    const r = c?.refund;
    if (!r || ids.has(r.id)) continue;
    ids.add(r.id);
    if (r.status !== "FAILED" && r.status !== "CANCELLED") {
      const m = minorIn(r.amount, currency);
      if (m === undefined) readable = false;
      else sum += m;
    }
    last = { label, refund: r, sum };
  }
  return { sum, readable, last };
}

/** P5's running total: the last refund POST reply that made a new refund, against the refunds made so far. */
function runningTotal(run: RefundRun): string {
  const hidden = hiddenRefundAt(run);
  if (hidden) return `unanswered (${hidden} may have made a refund the spike never saw)`;
  const { readable, last } = refundsSeen(run);
  if (!last) return "not seen";
  const t = last.refund.seller_payable_breakdown?.total_refunded_amount;
  if (!t) return `unknown (absent on ${last.label})`;
  if (!readable) return `unknown (${last.label} shows ${fmtMoney(t)}; a refund's amount was unreadable)`;
  const currency = run.captured.currency_code;
  return minorIn(t, currency) === last.sum
    ? `yes (${last.label} shows ${fmtMoney(t)}, the sum of the refunds so far)`
    : `no (${last.label} shows ${fmtMoney(t)}; the refunds so far sum to ${fmtMoney(money(currency, last.sum))})`;
}

/**
 * P5 on GET: e4b's total (e1 read again after e4) against the refunds made by then. "yes" means GET shows the
 * capture's running total; "no ..., as on e1's reply" means it shows the total from when e1 was made.
 */
function getAfterE4(run: RefundRun): string {
  const c = run.e4b;
  if (!c) return "not run";
  if (c.skipped) return `not run (${c.skipped})`;
  const t = c.refund?.seller_payable_breakdown?.total_refunded_amount;
  if (!c.refund) return "not seen";
  if (!t) return "absent";
  const hidden = hiddenRefundAt(run);
  if (hidden) return `unanswered (${fmtMoney(t)}; ${hidden} may have made a refund the spike never saw)`;
  const { sum, readable } = refundsSeen(run);
  if (!readable) return `unknown (${fmtMoney(t)}; a refund's amount was unreadable)`;
  const currency = run.captured.currency_code;
  const shown = minorIn(t, currency);
  if (shown === sum) return `running total yes (${fmtMoney(t)})`;
  const atE1 = run.e1?.refund?.seller_payable_breakdown?.total_refunded_amount;
  const asOnE1 = atE1 && minorIn(atE1, currency) === shown ? ", as on e1's reply" : "";
  return `running total no (${fmtMoney(t)}${asOnE1}; the refunds so far sum to ${fmtMoney(money(currency, sum))})`;
}

export const PREMISES_HEADING = "Refund premises (DESIGN.md §19-§20)";
const NOT_ANSWERED =
  "Not answered by the spike: P3 the resource of PAYMENT.CAPTURE.REFUNDED and of PAYMENT.CAPTURE.REVERSED (a refund, resource_type refund?), P4 the exact refund failure event names (PAYMENT.REFUND.FAILED? PAYMENT.REFUND.CANCELLED?), P6 a refund that is PENDING and then FAILED or CANCELLED. These need the developer dashboard's webhook simulator and the sandbox webhook event log.";

/** The premise block printed after the table (DESIGN.md §5 S12 names P1-P7). A pure function of the run. */
export function refundPremises(run: RefundRun): string[] {
  if (run.refused) return [PREMISES_HEADING, `not run: ${run.refused}`, NOT_ANSWERED].map(scrub);
  const seen = (c: RefundCall | undefined, f: (r: Refund) => string) => (c?.refund ? f(c.refund) : "not seen");
  const e2 = repeatAnswer(run.e2, run.e1?.refund?.id, "same refund id");
  const e6 = repeatAnswer(run.e6, run.e4?.refund?.id, "same refund id as e4");
  const custom = (r: Refund) => customIdOf(r, run);
  const up = (r: Refund) => upLinkOf(r, run);
  return [
    PREMISES_HEADING,
    `P1 dedupe (e2, e6): e2 ${e2.text}; e6 ${e6.text} → ${dedupeVerdict(e2.kind, e6.kind)}`,
    `P2 custom_id: on the reply ${seen(run.e1, custom)}; on GET ${seen(run.e3, custom)}`,
    `P2b up link to this capture: on the reply ${seen(run.e1, up)}; on GET ${seen(run.e3, up)}`,
    `P5 total_refunded_amount: on the reply ${seen(run.e1, totalOf)}; on GET ${seen(run.e3, totalOf)}; running total ${runningTotal(run)}; GET after e4 ${getAfterE4(run)}`,
    `P7 refusal issues: e5 ${refusalAnswer(run.e5, undefined)}; e6 ${refusalAnswer(run.e6, run.e4?.refund?.id)}`,
    NOT_ANSWERED,
  ].map(scrub);
}

/**
 * One random id per independent run: it seeds every PayPal-Request-Id and the invoice id, so two runs
 * (even in the same second) never replay each other's orders. Only a deliberate retry of the same
 * operation should reuse it.
 */
export function newRunId(): string {
  return randomUUID();
}

/**
 * DESIGN.md S11: asks GET /v1/identity/openidconnect/userinfo with the app's token and reports the identity
 * fields PayPal returns (payer_id, user_id, account_type, and the field names). It never prints a token.
 * The app refuses to start unless payer_id equals PAYPAL_OPERATOR_MERCHANT_ID; this row shows whether it can.
 */
export async function identityRow(api: Pick<PaymentsApi, "getOperatorIdentity">): Promise<Row> {
  const call = "GET /v1/identity/openidconnect/userinfo";
  try {
    const who = await api.getOperatorIdentity();
    const note = `payer_id ${who.merchant_id ?? "(absent or not a merchant id)"}; user_id ${who.user_id ?? "(absent)"}; account_type ${who.account_type ?? "(absent)"}; fields ${who.fields.join(",") || "(none)"}`;
    return { step: "a2 identity", call, status: "200", id: who.merchant_id ?? "", note: scrub(note) };
  } catch (e) {
    return { step: "a2 identity", call, status: e instanceof PayPalError ? String(e.status || e.kind) : "-", id: "", note: scrub(`${describeError(e)} (S11: this call can't confirm the operator)`) };
  }
}

async function main(): Promise<number> {
  let args: SpikeArgs;
  let env: ReturnType<typeof readEnv>;
  try {
    args = parseArgs(process.argv.slice(2));
    env = readEnv(process.env);
  } catch (e) {
    process.stderr.write(`${redact(e instanceof Error ? e.message : "bad arguments", [process.env.PAYPAL_CLIENT_ID ?? "", process.env.PAYPAL_CLIENT_SECRET ?? ""])}\n`);
    return 2;
  }
  // Every printed line goes through redact: no token, auth header, client id or secret reaches the screen.
  const out = (text: string) => process.stdout.write(`${redact(text, [env.clientId, env.clientSecret])}\n`);
  const { client, lastStatus, refundPosts } = spikeClient(env);
  const runId = newRunId();
  out(`Ambree PayPal spike ${runId} against ${client.baseUrl} (sandbox), payee ${JSON.stringify(args.payee)}, ${args.currency} ${args.value}`);

  // (a) the token, on its own so a credential problem is reported as such.
  const rows: Row[] = [];
  try {
    await client.getOrder("SPIKE0TOKEN0CHECK").catch((e: unknown) => {
      if (e instanceof PayPalError && e.status === 404) return; // the token worked; the order doesn't exist
      throw e;
    });
    rows.push({ step: "a token", call: "POST /v1/oauth2/token", status: "200", id: "", note: "token cached (never printed)" });
  } catch (e) {
    rows.push({ step: "a token", call: "POST /v1/oauth2/token", status: e instanceof PayPalError ? String(e.status || e.kind) : "-", id: "", note: scrub(describeError(e)) });
    out(`\n${formatTable(rows)}`);
    return 1;
  }
  // (a2) S11: who does PayPal say owns this REST app? Informational: a failure here doesn't stop the run.
  rows.push(await identityRow(client));

  const result = await runSpike({ api: client, args, runId, print: out, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), lastStatus, refundPosts });
  const block = result.refunds ? `\n\n${refundPremises(result.refunds).join("\n")}` : "";
  out(`\n${formatTable([...rows, ...result.rows])}${block}\n\n${result.ok ? "SPIKE OK" : "SPIKE FAILED"}: paste this table${block ? " and the premise block" : ""} into the CTO's notes.`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
