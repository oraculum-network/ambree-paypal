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
//
// Since 3 Nov (DESIGN.md §21): PayPal refuses the operator's app a refund of the guide's capture, so the
// refund calls go through PAYPAL_REFUND_CLIENT_ID/_SECRET (the payee's own app) when set; (a2) reads each
// app's owner by the payee echo. To rerun e1-e6 on a capture that already exists (no new order):
//
//   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… PAYPAL_REFUND_CLIENT_ID=… PAYPAL_REFUND_CLIENT_SECRET=… \
//     node scripts/spike.ts --capture CAPTURE_ID --remaining 9.00
//
// --remaining is A, what is left on the capture: (e0) reads the capture first, and e1's total_refunded_amount
// must then show the capture's amount less A, plus e1's 1.00, or the run stops before e2.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type PayPalClientOptions, PayPalRestClient } from "../src/paypal/client.ts";
import { PayPalError } from "../src/paypal/errors.ts";
import { formatMoney, isCurrency, money, toMinor } from "../src/paypal/money.ts";
import { assertSandboxBase } from "../src/paypal/sandbox.ts";
import type { PaymentsApi } from "../src/paypal/api.ts";
import { type Capture, type CreateOrderRequest, type CurrencyCode, type Money, type Order, type Payee, type Refund, type RefundRequest, approveLink, firstCapture } from "../src/paypal/types.ts";

export interface SpikeArgs {
  /** The order's payee; absent with --capture (no order is made). */
  payee?: Payee;
  currency: CurrencyCode;
  value: string;
  timeoutSec: number;
  pollSec: number;
  refund: boolean;
  paymentSource: boolean;
  /**
   * --capture <id> --remaining <amount> (DESIGN.md §21, D6): no order (a-d are skipped); e1-e6 run on this
   * existing capture with A = `remaining`, what is left on it, so the run never refunds more than that.
   */
  capture?: { id: string; remaining: string };
}

export const USAGE =
  "usage: node scripts/spike.ts (--payee-email EMAIL | --payee-merchant-id ID) [--currency EUR|USD] [--amount 10.00] [--timeout 600] [--poll 5] [--no-refund] [--with-payment-source]\n   or: node scripts/spike.ts --capture CAPTURE_ID --remaining 9.00";

const AMOUNT_RE = /^\d{1,4}\.\d{2}$/;

export function parseArgs(argv: string[]): SpikeArgs {
  const out: SpikeArgs = { currency: "EUR", value: "10.00", timeoutSec: 600, pollSec: 5, refund: true, paymentSource: false };
  let email: string | undefined;
  let merchant: string | undefined;
  let captureId: string | undefined;
  let remaining: string | undefined;
  /** Flags that make an order; --capture takes none of them. */
  const orderFlags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`);
      return v;
    };
    if (flag !== "--capture" && flag !== "--remaining") orderFlags.push(flag);
    switch (flag) {
      case "--capture":
        captureId = next();
        if (!/^[A-Z0-9]{8,32}$/.test(captureId)) throw new Error("--capture should be a PayPal capture id (capital letters and digits)");
        break;
      case "--remaining":
        remaining = next();
        if (!AMOUNT_RE.test(remaining)) throw new Error(`--remaining must look like 9.00\n${USAGE}`);
        break;
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
        if (!AMOUNT_RE.test(v)) throw new Error(`--amount must look like 10.00\n${USAGE}`);
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
  if (captureId !== undefined || remaining !== undefined) {
    if (captureId === undefined || remaining === undefined) throw new Error(`--capture and --remaining go together\n${USAGE}`);
    if (orderFlags.length) throw new Error(`--capture takes only --remaining (it makes no order): drop ${orderFlags.join(", ").slice(0, 80)}\n${USAGE}`);
    out.capture = { id: captureId, remaining };
    return out;
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

/**
 * Reads the credentials by name. Errors name the variable only. `refund` is the payee's own REST app
 * (PAYPAL_REFUND_CLIENT_ID/_SECRET, both or neither): every refund call goes through it when set, since PayPal
 * refuses the operator's app a refund of another account's capture (spike, 3 Nov; DESIGN.md §21).
 */
export function readEnv(env: Record<string, string | undefined>): { clientId: string; clientSecret: string; baseUrl: string; refund?: { clientId: string; clientSecret: string } } {
  const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`set ${missing.join(" and ")} (sandbox REST app credentials)`);
  const rid = env.PAYPAL_REFUND_CLIENT_ID;
  const rsecret = env.PAYPAL_REFUND_CLIENT_SECRET;
  if (Boolean(rid) !== Boolean(rsecret)) throw new Error("set both PAYPAL_REFUND_CLIENT_ID and PAYPAL_REFUND_CLIENT_SECRET, or neither (the payee's own REST app, which makes the refunds)");
  return { clientId: env.PAYPAL_CLIENT_ID!, clientSecret: env.PAYPAL_CLIENT_SECRET!, baseUrl: assertSandboxBase(env.PAYPAL_BASE_URL), ...(rid && rsecret ? { refund: { clientId: rid, clientSecret: rsecret } } : {}) };
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
  /** The operator's app: the order, its approval poll, the capture, and --capture's read of the capture. */
  api: PaymentsApi;
  /** Where the refund calls (POST and GET) go: the payee's own app (PAYPAL_REFUND_CLIENT_*). Default: `api`. */
  refundApi?: Pick<PaymentsApi, "refundCapture" | "getRefund">;
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
  /** The operator's app (PAYPAL_CLIENT_ID). */
  client: PayPalRestClient;
  /** The refund app (PAYPAL_REFUND_CLIENT_ID), or `client` itself when none is given. */
  refunder: PayPalRestClient;
  /** The HTTP status of the last exchange, by either client. */
  lastStatus: () => number;
  /**
   * Refund POST exchanges PayPal may have acted on, by either client. A 401 isn't one: PayPal refused the
   * token without acting, and the client sends the request again with a new token.
   */
  refundPosts: () => number;
}

/**
 * The spike's PayPal clients (writeRetries SPIKE_WRITE_RETRIES) and their shared onCall counters: the
 * operator's, and the refund app's when `refund` names one. main and the tests build them here.
 */
export function spikeClient(opts: Omit<PayPalClientOptions, "onCall" | "writeRetries">, refund?: { clientId: string; clientSecret: string }): SpikeClient {
  let last = 0;
  let refundPosts = 0;
  const onCall: PayPalClientOptions["onCall"] = (c) => {
    last = c.status;
    if (c.call === REFUND_CALL && c.status !== 401) refundPosts++;
  };
  const client = new PayPalRestClient({ ...opts, writeRetries: SPIKE_WRITE_RETRIES, onCall });
  const refunder = refund ? new PayPalRestClient({ ...opts, ...refund, writeRetries: SPIKE_WRITE_RETRIES, onCall }) : client;
  return { client, refunder, lastStatus: () => last, refundPosts: () => refundPosts };
}

function describeError(e: unknown): string {
  return e instanceof PayPalError ? e.summary() : e instanceof Error ? e.message : "unknown error";
}

export interface SpikeResult {
  rows: Row[];
  ok: boolean;
  /** Why the run is not OK, for the SPIKE FAILED line (refundProblems for (e)). */
  problem?: string;
  refunds?: RefundRun;
}

/** What a run has collected so far. main passes one in, so a run that throws still prints what it saw. */
export interface SpikeProgress {
  /** The rows of (b)-(d). (e)'s rows are refundRows(refunds). */
  rows: Row[];
  /** The refund sequence, filled in as it goes. */
  refunds?: RefundRun;
}

/**
 * Runs (b)-(e). Returns the rows, whether every step that ran succeeded (for (e), every planned call ran:
 * refundOk) and why not, and what the refund sequence saw, for the premise block.
 */
export async function runSpike(d: SpikeDeps, progress: SpikeProgress = { rows: [] }): Promise<SpikeResult> {
  const rows = progress.rows;
  const status = () => String(d.lastStatus() || "-");
  const stopped = (step: string): SpikeResult => ({ rows, ok: false, problem: `stopped at ${step} (see its row)` });
  const fail = (step: string, call: string, e: unknown) => {
    rows.push({ step, call, status: e instanceof PayPalError ? String(e.status || e.kind) : "-", id: "", note: scrub(describeError(e)) });
    return stopped(step);
  };

  if (d.args.capture) {
    // --capture (D6): a-d are skipped. e0 reads the capture (a GET by the operator's app; nothing moves), so
    // --remaining is checked against its amount and status before any refund is sent.
    let cap: Capture;
    try {
      cap = await d.api.getCapture(d.args.capture.id);
    } catch (e) {
      return fail("e0 capture", GET_CAPTURE_CALL, e);
    }
    const target = captureTarget(cap, d.args.capture.remaining);
    rows.push({ step: "e0 capture", call: GET_CAPTURE_CALL, status: status(), id: String(cap.id ?? "").slice(0, 64), note: scrub(target.note) });
    const refunds = await runRefundPremises(d, target, progress);
    const problems = refundProblems(refunds);
    return { rows: [...rows, ...refundRows(refunds)], ok: problems.length === 0, problem: problems.join("; ") || undefined, refunds };
  }

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
    return stopped("c approve");
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
      return stopped("c poll");
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
  if (!capture) return stopped("d capture");

  if (!d.args.refund) {
    rows.push({ step: "e refund", call: "-", status: "-", id: "", note: "skipped (--no-refund)" });
    return { rows, ok: true };
  }
  const refunds = await runRefundPremises(d, { captureId: capture.id, amount: capture.amount }, progress);
  const problems = refundProblems(refunds);
  return { rows: [...rows, ...refundRows(refunds)], ok: problems.length === 0, problem: problems.join("; ") || undefined, refunds };
}

/** What e1-e6 run on: the capture, A, and (--capture) what was refunded on it before this run. */
interface RefundTarget {
  captureId: string;
  /** A, or undefined when it can't be read (the sequence is then refused). */
  amount: Money | undefined;
  /** --capture only: the capture's amount C less --remaining, in A's minor units. */
  priorMinor?: number;
  /** Set when --capture's checks refuse the sequence before any refund. */
  refused?: string;
  /** e0's note. */
  note: string;
}

const GET_CAPTURE_CALL = "GET /v2/payments/captures/{id}";

/**
 * --capture's target, from the capture PayPal shows now (amount C, status) and --remaining (A). Refused,
 * before any refund, when A can't be what is left: more than C; not all of C while the capture shows no
 * refund (COMPLETED); all of C while it shows one (PARTIALLY_REFUNDED); or the capture is anything else
 * (REFUNDED, PENDING, ...). e1's total_refunded_amount then confirms C − A (refundPremises' e1 check).
 */
function captureTarget(cap: Capture, remaining: string): RefundTarget {
  const c = cap.amount;
  const id = String(cap.id ?? "");
  let cMinor: number;
  try {
    if (!c || !isCurrency(c.currency_code)) throw new RangeError("no amount");
    cMinor = toMinor(String(c.value));
  } catch {
    return { captureId: id, amount: undefined, refused: "the capture carries no amount the spike can read", note: `${String(cap.status).slice(0, 30)}; amount unreadable` };
  }
  const a = money(c.currency_code, toMinor(remaining));
  const aMinor = toMinor(a.value);
  const status = String(cap.status).slice(0, 30);
  const prior = cMinor - aMinor;
  const note = `${status}; ${formatMoney(c)}; --remaining ${formatMoney(a)}${prior >= 0 ? `, so ${formatMoney(money(c.currency_code, prior))} was refunded before this run` : ""}`;
  const refuse = (why: string): RefundTarget => ({ captureId: id, amount: a, refused: why, note });
  if (aMinor > cMinor) return refuse(`--remaining ${formatMoney(a)} is more than the capture's amount (${formatMoney(c)})`);
  if (status === "COMPLETED" && aMinor !== cMinor) return refuse(`the capture is COMPLETED (nothing refunded yet), so all of it (${formatMoney(c)}) remains, not --remaining ${formatMoney(a)}`);
  if (status === "PARTIALLY_REFUNDED" && aMinor === cMinor) return refuse(`the capture is PARTIALLY_REFUNDED, so less than all of it (${formatMoney(c)}) remains, not --remaining ${formatMoney(a)}`);
  if (status !== "COMPLETED" && status !== "PARTIALLY_REFUNDED") return refuse(`the capture is ${status}; there is nothing left to refund`);
  if (aMinor < MIN_A_MINOR) return refuse(`--remaining ${formatMoney(a)}; the premise sequence needs at least 2.00 left on the capture (e1's 1.00 plus a possible duplicate)`);
  return { captureId: id, amount: a, priorMinor: prior, note };
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
  /** A: what the run may refund. The captured amount, from the capture reply, or --remaining (--capture). */
  captured: Money;
  /** --capture: what the capture had refunded before this run (its amount less --remaining). PayPal's totals count it. */
  prior?: Money;
  /** --capture: e1's total_refunded_amount checked against `prior`; not ok stops the run before e2. */
  check?: { ok: boolean; note: string };
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
    } else if (!c.error || c.error.maybeDelivered) {
      // A lost or unreadable reply (or none at all): PayPal may have refunded.
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

/** A reply the spike can read as a refund: an object with a string id. */
function isRefundReply(x: unknown): x is Refund {
  return typeof x === "object" && x !== null && typeof (x as { id?: unknown }).id === "string" && (x as { id: string }).id.length > 0;
}

/**
 * A 2xx whose body is no refund (empty, unreadable, or without an id). On a refund POST PayPal acted on it,
 * so it may have refunded: the guard counts it, and it is never read as DEDUPED.
 */
function invalidReply(call: string, http: number, post: boolean): RefundCall {
  return { http, error: { kind: "invalid_response", issues: [], summary: `${call} · HTTP ${http} · no refund in the reply`, maybeDelivered: post } };
}

function callFromError(e: unknown): RefundCall {
  if (e instanceof PayPalError) return { http: e.status, error: { kind: e.kind, issues: e.issues, summary: scrub(e.summary()), maybeDelivered: e.maybeDelivered } };
  return { http: 0, error: { kind: "error", issues: [], summary: scrub(e instanceof Error ? e.message : "unknown error"), maybeDelivered: true } };
}

/**
 * e1-e6 on the capture. Stops after e1 if e1 made no refund, and (--capture) if e1's total doesn't confirm
 * --remaining. Every refund POST passes the guard first. Every refund call goes through `d.refundApi`.
 */
async function runRefundPremises(d: SpikeDeps, target: Omit<RefundTarget, "note">, progress: SpikeProgress): Promise<RefundRun> {
  const a = target.amount;
  const run: RefundRun = { captureId: target.captureId, captured: a as Money, customId: `spike-${d.runId}` };
  progress.refunds = run;
  if (target.refused) {
    run.refused = target.refused;
    return run;
  }
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
  if (target.priorMinor !== undefined) run.prior = money(currency, target.priorMinor);
  const refunds = d.refundApi ?? d.api;
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
      const refund: unknown = await refunds.refundCapture(target.captureId, b, requestId);
      c = isRefundReply(refund) ? { http: d.lastStatus(), refund } : invalidReply(REFUND_CALL, d.lastStatus(), true);
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
  if (run.prior) {
    // --capture: PayPal's running total on e1's reply must be what was refunded before (C − A) plus e1's
    // 1.00. Anything else means --remaining is wrong, and e4's "rest of A" or a probe could then move money
    // the run doesn't expect: stop before e2.
    const t = r1.seller_payable_breakdown?.total_refunded_amount;
    const expected = money(currency, toMinor(run.prior.value) + STEP_MINOR);
    const given = `--remaining ${formatMoney(a)}`;
    if (!t) run.check = { ok: false, note: `e1's reply has no total_refunded_amount, so ${given} can't be checked; nothing more was sent` };
    else if (minorIn(t, currency) !== toMinor(expected.value)) {
      run.check = { ok: false, note: `e1's total_refunded_amount is ${fmtMoney(t)}, but ${given} on a capture of ${formatMoney(money(currency, toMinor(run.prior.value) + capturedMinor))} means PayPal should show ${formatMoney(expected)}; nothing more was sent (rerun with the right --remaining)` };
    } else run.check = { ok: true, note: `consistent with --remaining: total_refunded_amount ${fmtMoney(t)} = ${formatMoney(run.prior)} before this run + e1's ${formatMoney(money(currency, STEP_MINOR))}` };
    if (!run.check.ok) return run;
  }
  run.e2 = await post("e2", b1, id1, "room");

  const get = async (refundId: string): Promise<RefundCall> => {
    try {
      const refund: unknown = await refunds.getRefund(refundId, target.captureId);
      return isRefundReply(refund) ? { http: d.lastStatus(), refund } : invalidReply(GET_REFUND_CALL, d.lastStatus(), false);
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
const isGet = (key: StepKey) => key === "e3" || key === "e4b";
/** The steps a refusal answers: P1's repeats (e2, e6) and P7's probes (e5, e6). */
const isPremise = (key: StepKey) => key === "e2" || key === "e5" || key === "e6";

/**
 * A refusal, which answers P1 or P7: a 422, or another 4xx that names at least one issue and isn't 401, 403
 * or 429 (the token, a permission or a rate limit say nothing about the refund). Never when an earlier
 * attempt's reply may have been lost. Any other reply without a refund is no answer.
 */
function isRefusal(c: RefundCall): boolean {
  if (c.refund || !c.error || c.error.maybeDelivered) return false;
  if (c.http === 422) return true;
  return is4xx(c) && c.http !== 401 && c.http !== 403 && c.http !== 429 && c.error.issues.length > 0;
}

/**
 * Whether a call that made no refund still answered its step: on e2, e5 and e6 only a refusal does; on e1,
 * e3, e4 and e4b PayPal's own error does (S4). A lost or unreadable reply, or none at all, never does.
 */
function answered(key: StepKey, c: RefundCall): boolean {
  const e = c.error;
  if (!e || e.kind === "invalid_response") return false;
  return isPremise(key) ? isRefusal(c) : !e.maybeDelivered;
}

/**
 * Why a call has no answer. A refund POST whose reply was lost (a network error, a timeout or a 5xx), was
 * unreadable, or was refused after an earlier attempt's reply was lost, may have refunded. A 4xx that isn't
 * a refusal (see isRefusal) says nothing about the refund.
 */
function noAnswer(c: RefundCall, post: boolean): string {
  const e = c.error;
  if (!e) return "no answer (nothing came back)";
  if (e.kind === "invalid_response") return `no answer (HTTP ${c.http || "2xx"} with no refund in the reply${post ? "; PayPal may have refunded" : ""})`;
  if (e.maybeDelivered) {
    if (!post) return "no answer (the reply was lost)";
    return is4xx(c) ? "no answer (an earlier attempt's reply may have been lost; PayPal may have refunded)" : "no answer (the reply may have been lost; PayPal may have refunded)";
  }
  if (is4xx(c)) return `no answer (HTTP ${c.http} is not a refusal)`;
  return `no answer (${e.kind})`;
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
    if (!answered(key, c)) return c.error ? `${noAnswer(c, !isGet(key))}: ${errorNote(c)}` : noAnswer(c, !isGet(key));
    const e = c.error!;
    if (key === "e5") return `refused as expected: HTTP ${c.http}; issues ${e.issues.join(", ") || "none"}; ${e.summary}`;
    if (key === "e6") return `refused: HTTP ${c.http}; issues ${e.issues.join(", ") || "none"}; ${e.summary}`;
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
      const prior = priorOf(run);
      // With an earlier refund (--capture), the capture is fully refunded at C = what was before + A.
      const whole = (minorIn(run.captured, cur) ?? 0) + prior;
      const label = prior ? "C, the capture's amount" : "A";
      const isA = !t ? "" : minorIn(t, cur) === whole ? ` (= ${label}: yes)` : ` (= ${label}: no, ${prior ? "C" : "A"} is ${fmtMoney(money(cur, whole))})`;
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

/** --capture: what was refunded on the capture before this run, in minor units of A's currency (0 otherwise). */
function priorOf(run: RefundRun): number {
  return (run.prior && minorIn(run.prior, run.captured.currency_code)) || 0;
}

/** The table rows for (e). With --capture, e1's check of --remaining follows e1 ("e1 check"). */
export function refundRows(run: RefundRun): Row[] {
  if (run.refused) return [{ step: "e refund", call: "-", status: "-", id: "", note: scrub(`refused: ${run.refused}`) }];
  const rows: Row[] = [];
  for (const [key, step, call] of STEPS) {
    const c = run[key];
    if (!c) continue;
    const status = String(c.http || c.error?.kind || "-");
    rows.push({ step, call, status, id: c.refund?.id ?? "", note: scrub(noteOf(key, c, run)) });
    if (key === "e1" && run.check) rows.push({ step: "e1 check", call: "-", status: "-", id: "", note: scrub(run.check.ok ? run.check.note : `stopped: ${run.check.note}`) });
  }
  return rows;
}

/** What a call came to, in a few words, for refundProblems. */
function outcomeOf(key: StepKey, c: RefundCall | undefined): string {
  if (!c) return "not run";
  if (c.skipped) return `not run (${c.skipped})`;
  if (c.guard) return "not sent (the money guard)";
  if (c.refund) return `refund ${c.refund.id}`;
  const e = c.error;
  if (!e || !answered(key, c)) return noAnswer(c, !isGet(key));
  const what = `HTTP ${c.http || e.kind}${e.issues.length ? ` ${e.issues.join(", ")}` : ""}`;
  return isPremise(key) ? `refused (${what})` : what;
}

/**
 * Why the sequence is not OK, one entry per call that didn't answer as its step can (none: OK). OK means
 * every planned call ran: e1-e4 with a refund (e2 deduped or not; e4 may be not needed), e5 with a refusal
 * (isRefusal), e6 with e4's refund or a refusal (or not needed when e4 wasn't). e4b is informational.
 */
export function refundProblems(run: RefundRun): string[] {
  if (run.refused) return ["the refund sequence didn't run (see its row)"];
  if (run.check && !run.check.ok) return [`e1 check: ${run.check.note}`];
  const { e1, e2, e3, e4, e5, e6 } = run;
  const out: string[] = [];
  const bad = (key: StepKey, c: RefundCall | undefined, more = "") => out.push(`${key}: ${outcomeOf(key, c)}${more}`);
  if (!e1?.refund) {
    bad("e1", e1);
    return out;
  }
  if (!e2?.refund) bad("e2", e2, e2 && isRefusal(e2) ? ", not the expected answer" : "");
  if (!e3?.refund) bad("e3", e3);
  if (!e4 || (!e4.refund && !e4.skipped)) bad("e4", e4);
  if (e5?.refund) out.push(`e5: PayPal accepted it (refund ${e5.refund.id}): UNEXPECTED`);
  else if (!e5 || !isRefusal(e5)) bad("e5", e5);
  if (e6?.refund) {
    if (e6.refund.id !== e4?.refund?.id) out.push(`e6: a new refund ${e6.refund.id}: UNEXPECTED`);
  } else if (e6?.skipped) {
    if (!e4?.skipped) bad("e6", e6);
  } else if (!e6 || !isRefusal(e6)) bad("e6", e6);
  return out;
}

/** OK: no refundProblems. */
export function refundOk(run: RefundRun): boolean {
  return refundProblems(run).length === 0;
}

type RepeatKind = "same" | "new" | "refused" | "error" | "notsent" | "notrun";

function repeatAnswer(c: RefundCall | undefined, firstId: string | undefined, sameText: string): { kind: RepeatKind; text: string } {
  if (!c) return { kind: "notrun", text: "not run" };
  if (c.skipped) return { kind: "notrun", text: `not run (${c.skipped})` };
  if (c.guard) return { kind: "notsent", text: `not sent (${c.guard})` };
  if (c.refund) return c.refund.id === firstId ? { kind: "same", text: `DEDUPED (${sameText})` } : { kind: "new", text: `NOT DEDUPED (new refund id ${c.refund.id})` };
  if (isRefusal(c)) return { kind: "refused", text: `refused (HTTP ${c.http} ${c.error!.issues.join(", ") || "with no issue names"})` };
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
  if (!isRefusal(c)) return noAnswer(c, true);
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
  const prior = priorOf(run);
  const before = prior ? ` and ${fmtMoney(money(currency, prior))} before this run` : "";
  return minorIn(t, currency) === last.sum + prior
    ? `yes (${last.label} shows ${fmtMoney(t)}, the sum of the refunds so far${before})`
    : `no (${last.label} shows ${fmtMoney(t)}; the refunds so far sum to ${fmtMoney(money(currency, last.sum))}${before})`;
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
  const prior = priorOf(run);
  if (shown === sum + prior) return `running total yes (${fmtMoney(t)})`;
  const atE1 = run.e1?.refund?.seller_payable_breakdown?.total_refunded_amount;
  const asOnE1 = atE1 && minorIn(atE1, currency) === shown ? ", as on e1's reply" : "";
  const before = prior ? ` and ${fmtMoney(money(currency, prior))} before this run` : "";
  return `running total no (${fmtMoney(t)}${asOnE1}; the refunds so far sum to ${fmtMoney(money(currency, sum))}${before})`;
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

/** How a run ended: with a result, or by throwing. */
export type SpikeOutcome = { result: SpikeResult } | { crash: unknown };

/** refundRows when they can't be rendered: each call's status and id only. */
function bareRefundRows(run: RefundRun): Row[] {
  return STEPS.filter(([key]) => run[key]).map(([key, step, call]) => ({ step, call, status: String(run[key]!.http || "-"), id: String(run[key]!.refund?.id ?? "").slice(0, 64), note: "(this row couldn't be shown)" }));
}

/**
 * What main prints after the run: the table (`head` and the run's rows), the premise block and the verdict.
 * If the run threw, it prints what `progress` collected, a row saying where the run stopped, and SPIKE
 * FAILED. It doesn't throw itself.
 */
export function spikeReport(head: Row[], progress: SpikeProgress, outcome: SpikeOutcome): { ok: boolean; text: string } {
  const attempt = <T>(f: () => T, fallback: () => T): T => {
    try {
      return f();
    } catch {
      return fallback();
    }
  };
  let rows: Row[];
  let problem: string | undefined;
  let ok = false;
  const refunds = "result" in outcome ? outcome.result.refunds : progress.refunds;
  if ("result" in outcome) {
    ({ rows, problem, ok } = outcome.result);
  } else {
    const why = scrub(describeError(outcome.crash));
    const refundPart = refunds ? attempt(() => refundRows(refunds), () => bareRefundRows(refunds)) : [];
    rows = [...progress.rows, ...refundPart, { step: "stopped", call: "-", status: "-", id: "", note: `the run stopped: ${why}` }];
    problem = `the run stopped: ${why}`;
  }
  const block = refunds ? attempt(() => refundPremises(refunds), () => [PREMISES_HEADING, "(the premises couldn't be read from what the run saw)"]) : undefined;
  const verdict = ok ? "SPIKE OK" : `SPIKE FAILED (${problem ?? "see the table"})`;
  const text = `\n${formatTable([...head, ...rows])}${block ? `\n\n${block.join("\n")}` : ""}\n\n${verdict}: keep this table${block ? " and the premise block" : ""} with your notes.`;
  return { ok, text };
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
 * DESIGN.md §21 (D3): who owns the app, as the app checks it at startup. It creates the identity probe (an
 * order with no payee, never approved; it lapses) and prints the payee merchant_id PayPal echoes, the probe's
 * id and status, and the payee's field names. Compare the id with the dashboard's merchant id. It never
 * prints a token. (userinfo, the S11 call, had no payer_id.)
 */
export async function identityRow(api: Pick<PaymentsApi, "getAppOwner">, step = "a2 identity"): Promise<Row> {
  const call = "POST /v2/checkout/orders";
  try {
    const who = await api.getAppOwner();
    const note = `payee echo merchant_id ${who.merchant_id ?? "(absent or not a merchant id)"}; probe order ${who.order_id ?? "(no id)"} ${who.order_status ?? "(no status)"} (never approved; it lapses); payee fields ${who.payee_fields.join(",") || "(none)"}`;
    return { step, call, status: "201", id: who.merchant_id ?? "", note: scrub(note) };
  } catch (e) {
    return { step, call, status: e instanceof PayPalError ? String(e.status || e.kind) : "-", id: "", note: scrub(`${describeError(e)} (the app's owner can't be read this way)`) };
  }
}

/** (a2) for the operator's app, and for the refund app when one is set (and isn't the operator's client). */
export async function identityRows(operator: Pick<PaymentsApi, "getAppOwner">, refunder?: Pick<PaymentsApi, "getAppOwner">): Promise<Row[]> {
  const rows = [await identityRow(operator)];
  if (refunder && refunder !== operator) rows.push(await identityRow(refunder, "a2 identity (refund app)"));
  return rows;
}

async function main(): Promise<number> {
  let args: SpikeArgs;
  let env: ReturnType<typeof readEnv>;
  const named = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_REFUND_CLIENT_ID", "PAYPAL_REFUND_CLIENT_SECRET"].map((k) => process.env[k] ?? "");
  try {
    args = parseArgs(process.argv.slice(2));
    env = readEnv(process.env);
  } catch (e) {
    process.stderr.write(`${redact(e instanceof Error ? e.message : "bad arguments", named)}\n`);
    return 2;
  }
  // Every printed line goes through redact: no token, auth header, client id or secret reaches the screen.
  const out = (text: string) => process.stdout.write(`${redact(text, named)}\n`);
  const { client, refunder, lastStatus, refundPosts } = spikeClient(env, env.refund);
  const runId = newRunId();
  const refundsVia = env.refund ? "refunds via the refund app (PAYPAL_REFUND_CLIENT_ID)" : "refunds via the operator's app (no PAYPAL_REFUND_CLIENT_ID)";
  const what = args.capture ? `existing capture ${args.capture.id}, A = --remaining ${args.capture.remaining} (a-d skipped)` : `payee ${JSON.stringify(args.payee)}, ${args.currency} ${args.value}`;
  out(`Ambree PayPal spike ${runId} against ${client.baseUrl} (sandbox), ${what}, ${refundsVia}`);

  const rows: Row[] = [];
  if (!args.capture) {
    // (a) the token, on its own so a credential problem is reported as such.
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
    // (a2) who owns each app, by the payee echo (D3). Informational: a failure here doesn't stop the run.
    rows.push(...(await identityRows(client, env.refund ? refunder : undefined)));
  }

  // A run that throws still prints the rows and the premise block it has, then SPIKE FAILED.
  const progress: SpikeProgress = { rows: [] };
  let outcome: SpikeOutcome;
  try {
    outcome = { result: await runSpike({ api: client, refundApi: refunder, args, runId, print: out, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), lastStatus, refundPosts }, progress) };
  } catch (e) {
    outcome = { crash: e };
  }
  const report = spikeReport(rows, progress, outcome);
  out(report.text);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
