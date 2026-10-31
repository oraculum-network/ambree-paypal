// The booking service: the rules of "Book the guide". The agent's tools, the operator page, the PayPal
// return URL and the webhook endpoint all come through here, so the mandate check, payee pinning, refund
// policy and ledger writes hold whatever the model says. Money moves traveller → guide (the order's payee
// is the guide's own account) and back on a refund; the configured operator account is never a payee.

import { randomBytes } from "node:crypto";
import type { Guide } from "../guides/seed.ts";
import { sha256Hex } from "../ledger/canonical.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { type Mandate, type MandateView, type Mandates, type Quote, isOperator, quoteHash, samePayee, view } from "../mandate/mandate.ts";
import type { PaymentsApi } from "../paypal/api.ts";
import { PayPalError } from "../paypal/errors.ts";
import { formatMoney, fromMinor, sameMoney, toMinor } from "../paypal/money.ts";
import { type Capture, type CurrencyCode, type Money, type Order, type Payee, type Refund, type WebhookEvent, approveLink, firstCapture, transmissionFromHeaders } from "../paypal/types.ts";
import { type Db, Records, beginWebhook, finishWebhook, markWebhookLogged } from "../store/db.ts";
import { type CycloneAlert, type CycloneFeed, explainRisk } from "../weather/cyclones.ts";
import type { Channels } from "./channels.ts";

export type BookingStatus =
  | "requested"
  | "priced"
  | "declined"
  | "mandate_proposed"
  | "mandate_approved"
  | "order_created"
  | "capture_pending"
  | "capture_failed"
  | "needs_review"
  | "captured"
  | "partially_refunded"
  | "refunded";

/** One refund, persisted before it is sent, so a retry resends exactly the same request. */
export interface RefundOp {
  n: number;
  request_id: string;
  amount_minor: number;
  /** An empty body (full refund) rather than an amount. */
  full: boolean;
  reason: string;
  status: "sending" | "pending" | "completed" | "failed";
  refund_id?: string;
}

export interface Booking {
  id: string;
  conversation_id: string;
  guide_id: string;
  guide_name: string;
  activity: string;
  area: string;
  date: string;
  party_size: number;
  note: string;
  status: BookingStatus;
  quote?: Quote;
  quote_hash?: string;
  mandate_id?: string;
  /** Set when a create attempt had no definitive answer; it may be retried with the same nonce until the mandate expires. */
  order_pending?: boolean;
  order_id?: string;
  approve_url?: string;
  capture_id?: string;
  capture_status?: string;
  captured?: Money;
  /** Completed refunds only. */
  refunded_minor: number;
  refund_ids: string[];
  refund_ops: RefundOp[];
  reschedule?: { new_date: string; status: "proposed" | "accepted" | "declined" };
  refund_offered: boolean;
  created_at: string;
  updated_at: string;
}

export class ServiceError extends Error {
  override name = "ServiceError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ServiceDeps {
  db: Db;
  ledger: Ledger;
  mandates: Mandates;
  payments: PaymentsApi;
  guides: readonly Guide[];
  weather: CycloneFeed;
  channels: Channels;
  /** e.g. https://paypal.ambree.ai, for the operator link and PayPal's return URL. */
  publicUrl: string;
  /** The REST app owner's own accounts: an order to any of them is refused. */
  operatorPayees: readonly Payee[];
  now?: () => Date;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOT_FOUND = "No such booking in this conversation.";

function hashToken(token: string): string {
  return sha256Hex(`operator:${token}`);
}

function payeeLabel(p: Payee): string {
  return p.email_address ?? `merchant ${p.merchant_id}`;
}

/** PayPal said no (nothing was created or moved); anything else may have happened and must be reconciled. */
export function isDefinitive(e: unknown): boolean {
  if (!(e instanceof PayPalError)) return false;
  if (e.kind === "invalid_request" || e.kind === "auth") return true;
  return e.kind === "http" && [400, 401, 403, 404, 422].includes(e.status);
}

export class BookingService {
  readonly #d: ServiceDeps;
  readonly #bookings: Records<Booking>;
  readonly #tokens: Records<{ id: string; booking_id: string }>;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #now: () => Date;

  constructor(deps: ServiceDeps) {
    this.#d = deps;
    this.#bookings = new Records<Booking>(deps.db, "booking");
    this.#tokens = new Records(deps.db, "operator_token");
    this.#now = deps.now ?? (() => new Date());
  }

  get guides(): readonly Guide[] {
    return this.#d.guides;
  }

  guide(id: string): Guide | undefined {
    return this.#d.guides.find((g) => g.id === id);
  }

  get(id: string): Booking | undefined {
    return this.#bookings.get(id);
  }

  must(id: string): Booking {
    const b = this.#bookings.get(id);
    if (!b) throw new ServiceError("not_found", NOT_FOUND);
    return b;
  }

  /** The booking, only if it belongs to this conversation; another conversation's booking looks absent. */
  owned(id: string, conversationId: string): Booking {
    const b = this.#bookings.get(id);
    if (!b || b.conversation_id !== conversationId) throw new ServiceError("not_found", NOT_FOUND);
    return b;
  }

  forConversation(conversationId: string): Booking[] {
    return this.#bookings.list().filter((b) => b.conversation_id === conversationId);
  }

  mandateView(b: Booking): MandateView | undefined {
    const m = b.mandate_id ? this.#d.mandates.get(b.mandate_id) : undefined;
    return m ? view(m) : undefined;
  }

  #save(b: Booking): Booking {
    return this.#bookings.put({ ...b, updated_at: this.#now().toISOString() });
  }

  #log(b: Booking, kind: string, data: Record<string, unknown>) {
    return this.#d.ledger.append(b.id, kind, data);
  }

  /** Runs one booking's money steps one at a time (return URL, webhook and agent may race). */
  async #serial<T>(bookingId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(bookingId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    this.#locks.set(bookingId, run.catch(() => undefined));
    return run;
  }

  // ---------- 1. the request and the guide's price ----------

  requestQuote(input: { conversation_id: string; guide_id: string; date: string; party_size: number; activity: string; note?: string }): { booking: Booking; operatorUrl: string } {
    const g = this.guide(input.guide_id);
    if (!g) throw new ServiceError("unknown_guide", `No guide ${input.guide_id.slice(0, 40)}; use search_guides.`);
    if (!DATE_RE.test(input.date)) throw new ServiceError("bad_date", "date must be YYYY-MM-DD.");
    if (!Number.isInteger(input.party_size) || input.party_size < 1 || input.party_size > 12) throw new ServiceError("bad_party", "party_size must be 1 to 12.");
    const now = this.#now().toISOString();
    const token = randomBytes(32).toString("base64url");
    const b: Booking = {
      id: `bk_${randomBytes(6).toString("hex")}`,
      conversation_id: input.conversation_id,
      guide_id: g.id,
      guide_name: g.name,
      activity: input.activity,
      area: g.areas[0]!,
      date: input.date,
      party_size: input.party_size,
      note: (input.note ?? "").slice(0, 500),
      status: "requested",
      refunded_minor: 0,
      refund_ids: [],
      refund_ops: [],
      refund_offered: false,
      created_at: now,
      updated_at: now,
    };
    this.#bookings.put(b);
    this.#tokens.put({ id: hashToken(token), booking_id: b.id });
    this.#log(b, "quote.requested", { guide_id: g.id, activity: b.activity, date: b.date, party_size: b.party_size });
    return { booking: b, operatorUrl: `${this.#d.publicUrl}/o/${token}` };
  }

  byToken(token: string): Booking | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const t = this.#tokens.get(hashToken(token));
    return t ? this.#bookings.get(t.booking_id) : undefined;
  }

  #byTokenOrThrow(token: string): Booking {
    const b = this.byToken(token);
    if (!b) throw new ServiceError("bad_token", "This link is not valid.");
    return b;
  }

  /** The guide sets the price on the operator page. The quote is then frozen and hashed. */
  priceQuote(token: string, input: { total: string; deposit: string; note?: string }): Booking {
    const b = this.#byTokenOrThrow(token);
    if (b.status !== "requested") throw new ServiceError("already_answered", "This request already has an answer.");
    const g = this.guide(b.guide_id)!;
    let total: number;
    let deposit: number;
    try {
      total = toMinor(input.total.trim());
      deposit = toMinor(input.deposit.trim());
    } catch {
      throw new ServiceError("bad_amount", "Prices must be amounts like 80 or 80.00.");
    }
    if (total <= 0 || deposit <= 0 || deposit > total) throw new ServiceError("bad_amount", "The deposit must be more than 0 and at most the total.");
    if (total > 1_000_00) throw new ServiceError("bad_amount", "The demo caps a booking at 1000.00.");
    const cur: CurrencyCode = g.currency;
    const quote: Quote = {
      booking_id: b.id,
      guide_id: g.id,
      guide_name: g.name,
      activity: b.activity,
      area: b.area,
      date: b.date,
      party_size: b.party_size,
      total: { currency_code: cur, value: fromMinor(total) },
      deposit: { currency_code: cur, value: fromMinor(deposit) },
      payee: g.payee,
      guide_note: (input.note ?? "").trim().slice(0, 300),
      priced_at: this.#now().toISOString(),
    };
    const next = this.#save({ ...b, status: "priced", quote, quote_hash: quoteHash(quote) });
    this.#log(next, "quote.priced", { total: quote.total, deposit: quote.deposit, payee: quote.payee, quote_hash: next.quote_hash });
    this.#d.channels.emit(b.conversation_id, { type: "guide_priced", booking_id: b.id, text: `${g.name} priced the ${b.activity} on ${b.date}: total ${formatMoney(quote.total)}, deposit ${formatMoney(quote.deposit)}.` });
    return next;
  }

  declineRequest(token: string): Booking {
    const b = this.#byTokenOrThrow(token);
    if (b.status !== "requested") throw new ServiceError("already_answered", "This request already has an answer.");
    const next = this.#save({ ...b, status: "declined" });
    this.#log(next, "quote.declined", {});
    this.#d.channels.emit(b.conversation_id, { type: "guide_declined", booking_id: b.id, text: `${b.guide_name} can't do ${b.date}.` });
    return next;
  }

  // ---------- 2. the mandate ----------

  /** Builds the mandate from the frozen quote; the code goes to the traveller's inbox, not to the caller. */
  proposeMandate(bookingId: string): MandateView {
    const b = this.must(bookingId);
    if (b.status !== "priced" && b.status !== "mandate_proposed") throw new ServiceError("wrong_state", `The booking is ${b.status}; a mandate needs a priced quote.`);
    if (!b.quote) throw new ServiceError("no_quote", "The guide has not priced this yet.");
    const { mandate, code } = this.#d.mandates.propose(b.quote);
    const next = this.#save({ ...b, status: "mandate_proposed", mandate_id: mandate.id });
    this.#log(next, "mandate.proposed", { mandate_id: mandate.id, amount: mandate.amount, payee: mandate.payee, quote_hash: mandate.quote_hash, expires_at: mandate.expires_at });
    this.#d.channels.sendCode(b.conversation_id, {
      at: this.#now().toISOString(),
      booking_id: b.id,
      mandate_id: mandate.id,
      code,
      text: `Ambree: your code to approve ${formatMoney(mandate.amount)} to ${mandate.payee_name} is ${code}. Never share it.`,
    });
    return view(mandate);
  }

  /** The traveller approves with the step-up code. Only the web route calls this (after its session check); no tool does. */
  approveMandate(mandateId: string, code: string): Booking {
    const m = this.#d.mandates.get(mandateId);
    if (!m) throw new ServiceError("not_found", "No such mandate.");
    const b = this.must(m.booking_id);
    if (b.mandate_id !== m.id) throw new ServiceError("stale_mandate", "A newer mandate replaced this one.");
    const r = this.#d.mandates.approve(mandateId, code);
    if (!r.ok) {
      this.#log(b, "mandate.rejected", { mandate_id: m.id, reason: r.reason });
      throw new ServiceError(r.reason, r.message);
    }
    const next = this.#save({ ...b, status: "mandate_approved" });
    this.#log(next, "mandate.approved", { mandate_id: m.id, quote_hash: m.quote_hash, amount: m.amount, payee: m.payee });
    this.#d.channels.emit(b.conversation_id, { type: "mandate_approved", booking_id: b.id, text: `The traveller approved ${formatMoney(m.amount)} to ${m.payee_name}.` });
    return next;
  }

  // ---------- 3. the order, the buyer's approval and the capture ----------

  #isOperator(p: Payee): boolean {
    return isOperator(p, this.#d.operatorPayees);
  }

  /** What is wrong with an order PayPal returned, against the booking and its mandate (undefined = fine). */
  orderProblem(order: Order, b: Booking, m: Mandate): string | undefined {
    const units = order.purchase_units ?? [];
    if (units.length !== 1) return `expected 1 purchase unit, got ${units.length}`;
    const u = units[0]!;
    if (!u.payee) return "no payee (the funds would go to the operator)";
    if (this.#isOperator(u.payee)) return "the payee is the operator's own account";
    if (!samePayee(u.payee, m.payee)) return "the payee differs from the mandate";
    if (!u.amount || !sameMoney(u.amount, m.amount)) return "the amount or currency differs from the mandate";
    if (u.custom_id !== b.id && u.reference_id !== b.id) return "the order does not reference this booking";
    return undefined;
  }

  /** Creates the PayPal order with the guide as payee, only inside an approved, unexpired mandate. */
  async createOrder(bookingId: string): Promise<Booking> {
    return this.#serial(bookingId, async () => {
      const b = this.must(bookingId);
      if (b.order_id) return b;
      if (b.status !== "mandate_approved") throw new ServiceError("no_mandate", `No approved mandate (the booking is ${b.status}). Propose one and wait for the traveller.`);
      const g = this.guide(b.guide_id)!;
      if (this.#isOperator(g.payee)) {
        this.#log(b, "order.refused", { mandate_id: b.mandate_id, reason: "payee_is_operator" });
        throw new ServiceError("payee_is_operator", "The guide's payee is the operator's own account; refusing.");
      }
      let m: Mandate;
      if (b.order_pending) {
        // An earlier attempt got no definitive answer. Retrying with the same nonce lets PayPal return
        // that order if it exists, but only while the mandate is still valid.
        m = this.#d.mandates.get(b.mandate_id!)!;
        if (this.#now().getTime() >= Date.parse(m.expires_at)) {
          this.#save({ ...b, status: "priced", order_pending: false });
          this.#log(b, "order.abandoned", { mandate_id: m.id, reason: "mandate expired after an ambiguous create" });
          throw new ServiceError("expired", "The mandate expired before the order was confirmed; propose a new one.");
        }
      } else {
        const r = this.#d.mandates.consume(b.mandate_id!, { quote: b.quote!, amount: b.quote!.deposit, payee: g.payee });
        if (!r.ok) {
          this.#log(b, "order.refused", { mandate_id: b.mandate_id, reason: r.reason });
          throw new ServiceError(r.reason, r.message);
        }
        m = r.value;
        this.#save({ ...b, order_pending: true });
      }
      let order: Order;
      try {
        order = await this.#d.payments.createOrder(
          {
            intent: "CAPTURE",
            purchase_units: [
              {
                reference_id: b.id,
                custom_id: b.id,
                invoice_id: `AMB-${b.id}`,
                description: `Deposit: ${b.activity} with ${b.guide_name}, ${b.date}, ${b.party_size} pax`.slice(0, 127),
                amount: m.amount,
                payee: m.payee,
              },
            ],
            payment_source: {
              paypal: {
                experience_context: {
                  return_url: `${this.#d.publicUrl}/paypal/return?booking=${b.id}`,
                  cancel_url: `${this.#d.publicUrl}/paypal/cancel?booking=${b.id}`,
                  user_action: "PAY_NOW",
                  shipping_preference: "NO_SHIPPING",
                  brand_name: "Ambree",
                },
              },
            },
          },
          m.nonce,
        );
      } catch (e) {
        if (isDefinitive(e)) {
          // PayPal refused: nothing exists. The mandate is spent; the traveller must approve a new one.
          const next = this.#save({ ...this.must(bookingId), status: "priced", order_pending: false });
          this.#log(next, "order.rejected", { mandate_id: m.id, status: (e as PayPalError).status, issue: (e as PayPalError).issue ?? null });
        } else {
          this.#log(b, "order.ambiguous", { mandate_id: m.id, error: e instanceof PayPalError ? e.kind : "unknown" });
        }
        throw e;
      }
      const problem = this.orderProblem(order, b, m);
      if (problem) {
        this.#save({ ...this.must(bookingId), status: "needs_review", order_pending: false, order_id: order.id });
        this.#log(b, "order.mismatch", { order_id: order.id, problem, stage: "create" });
        throw new ServiceError("order_mismatch", `PayPal's order does not match the mandate: ${problem}.`);
      }
      const next = this.#save({ ...this.must(bookingId), status: "order_created", order_pending: false, order_id: order.id, approve_url: approveLink(order) });
      this.#log(next, "order.created", { order_id: order.id, status: order.status, amount: m.amount, payee: order.purchase_units?.[0]?.payee ?? m.payee, mandate_id: m.id, quote_hash: m.quote_hash });
      return next;
    });
  }

  async getOrder(bookingId: string): Promise<Order> {
    const b = this.must(bookingId);
    if (!b.order_id) throw new ServiceError("no_order", "No PayPal order yet.");
    return this.#d.payments.getOrder(b.order_id);
  }

  /**
   * Captures once the buyer approved, after checking the order still matches the mandate; then reconciles
   * the capture. Only a COMPLETED capture of the mandate's amount counts as paid. A PENDING capture is
   * refreshed by GET on the next call (the PAYMENT.CAPTURE.* webhooks make that call). Idempotent.
   */
  async captureIfApproved(bookingId: string): Promise<{ booking: Booking; captured: boolean; order_status: string; capture_status?: string }> {
    return this.#serial(bookingId, async () => {
      const b = this.must(bookingId);
      if (b.status === "captured" || b.status === "partially_refunded" || b.status === "refunded") return { booking: b, captured: true, order_status: "COMPLETED", capture_status: b.capture_status };
      if (b.status === "needs_review" || b.status === "capture_failed") return { booking: b, captured: false, order_status: b.status, capture_status: b.capture_status };
      if (!b.order_id) throw new ServiceError("no_order", "No PayPal order yet.");
      const m = this.#d.mandates.get(b.mandate_id!)!;
      let order = await this.#d.payments.getOrder(b.order_id);
      const before = this.orderProblem(order, b, m);
      if (before) {
        const next = this.#save({ ...b, status: "needs_review" });
        this.#log(next, "order.mismatch", { order_id: order.id, problem: before, stage: "before_capture" });
        throw new ServiceError("order_mismatch", `The PayPal order no longer matches the mandate (${before}); not capturing.`);
      }
      if (b.status !== "capture_pending" && order.status === "APPROVED") {
        try {
          order = await this.#d.payments.captureOrder(order.id, `capture-${order.id}`);
        } catch (e) {
          if (!(e instanceof PayPalError && e.issue === "ORDER_ALREADY_CAPTURED")) throw e;
          order = await this.#d.payments.getOrder(b.order_id);
        }
      }
      const cap = firstCapture(order);
      if (!cap) return { booking: b, captured: false, order_status: order.status };
      return this.#reconcileCapture(b, m, order, cap);
    });
  }

  #reconcileCapture(b: Booking, m: Mandate, order: Order, cap: Capture): { booking: Booking; captured: boolean; order_status: string; capture_status: string } {
    const after = this.orderProblem(order, b, m);
    if (after || !sameMoney(cap.amount, m.amount)) {
      const next = this.#save({ ...b, status: "needs_review", capture_id: cap.id, capture_status: cap.status });
      this.#log(next, "capture.reconcile_failed", { order_id: order.id, capture_id: cap.id, status: cap.status, amount: cap.amount, expected: m.amount, problem: after ?? "capture amount differs from the mandate" });
      return { booking: next, captured: false, order_status: order.status, capture_status: cap.status };
    }
    if (cap.status === "COMPLETED" || cap.status === "PARTIALLY_REFUNDED" || cap.status === "REFUNDED") {
      const next = this.#save({ ...b, status: "captured", capture_id: cap.id, capture_status: cap.status, captured: cap.amount });
      this.#log(next, "capture.completed", { order_id: order.id, capture_id: cap.id, status: cap.status, amount: cap.amount, payee: order.purchase_units?.[0]?.payee, payer_id: order.payer?.payer_id });
      this.#d.channels.emit(b.conversation_id, { type: "paid", booking_id: b.id, text: `Paid: ${formatMoney(cap.amount)} went to ${b.guide_name}'s PayPal (capture ${cap.id}). The spot is held for ${b.date}.` });
      return { booking: next, captured: true, order_status: order.status, capture_status: cap.status };
    }
    if (cap.status === "PENDING") {
      const next = this.#save({ ...b, status: "capture_pending", capture_id: cap.id, capture_status: cap.status });
      if (b.status !== "capture_pending") this.#log(next, "capture.pending", { order_id: order.id, capture_id: cap.id, amount: cap.amount });
      return { booking: next, captured: false, order_status: order.status, capture_status: cap.status };
    }
    const next = this.#save({ ...b, status: "capture_failed", capture_id: cap.id, capture_status: cap.status });
    this.#log(next, "capture.failed", { order_id: order.id, capture_id: cap.id, status: cap.status });
    return { booking: next, captured: false, order_status: order.status, capture_status: cap.status };
  }

  // ---------- 4. webhooks ----------

  #findForResource(resource: Record<string, unknown>): Booking | undefined {
    const units = resource.purchase_units as Array<{ custom_id?: string }> | undefined;
    const custom = (typeof resource.custom_id === "string" ? resource.custom_id : undefined) ?? units?.[0]?.custom_id;
    if (custom && custom.startsWith("bk_")) {
      const b = this.get(custom);
      if (b) return b;
    }
    const id = typeof resource.id === "string" ? resource.id : undefined;
    return id ? this.#bookings.list().find((b) => b.order_id === id || b.capture_id === id || b.refund_ops.some((o) => o.refund_id === id)) : undefined;
  }

  /**
   * POST /webhooks/paypal: verify with PayPal, log once, react. An event is a duplicate only once its
   * processing completed; if processing fails the reply is 500, so PayPal redelivers and we try again.
   */
  async handleWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<{ status: number; result: string }> {
    const t = transmissionFromHeaders(headers);
    if (!t) return { status: 400, result: "missing PAYPAL-* transmission headers" };
    let event: WebhookEvent;
    try {
      event = JSON.parse(rawBody) as WebhookEvent;
    } catch {
      return { status: 400, result: "body is not JSON" };
    }
    if (!event || typeof event.id !== "string" || typeof event.event_type !== "string" || !event.resource || typeof event.resource !== "object") {
      return { status: 400, result: "not a webhook event" };
    }
    let verified = false;
    try {
      verified = await this.#d.payments.verifyWebhookSignature(t, event);
    } catch {
      return { status: 503, result: "could not verify (PayPal will retry)" };
    }
    if (!verified) return { status: 400, result: "signature not verified" };
    const at = this.#now().toISOString();
    const begun = beginWebhook(this.#d.db, event.id, event.event_type, at);
    if (begun.duplicate) return { status: 200, result: "duplicate" };
    const b = this.#findForResource(event.resource);
    if (!b) {
      finishWebhook(this.#d.db, event.id, "completed", at);
      return { status: 200, result: "no matching booking" };
    }
    const r = event.resource as { id?: string; status?: string; amount?: Money };
    if (!begun.logged) {
      this.#log(b, `webhook.${event.event_type}`, { event_id: event.id, resource_type: event.resource_type, resource_id: r.id, status: r.status, amount: r.amount, verified: true });
      markWebhookLogged(this.#d.db, event.id);
    }
    try {
      if (event.event_type === "CHECKOUT.ORDER.APPROVED" || event.event_type.startsWith("PAYMENT.CAPTURE.") && event.event_type !== "PAYMENT.CAPTURE.REFUNDED") {
        if (b.order_id) await this.captureIfApproved(b.id);
      } else if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
        await this.refreshRefunds(b.id);
      }
      finishWebhook(this.#d.db, event.id, "completed", this.#now().toISOString());
      return { status: 200, result: "logged" };
    } catch (e) {
      finishWebhook(this.#d.db, event.id, "failed", this.#now().toISOString());
      this.#log(b, "webhook.processing_failed", { event_id: event.id, attempt: begun.attempts, error: e instanceof PayPalError ? e.summary() : e instanceof ServiceError ? e.code : "unknown" });
      return { status: 500, result: "processing failed; PayPal will redeliver" };
    }
  }

  // ---------- 5. weather, reschedule, refund ----------

  async weatherFor(bookingId: string): Promise<{ alerts: CycloneAlert[]; explanation: string }> {
    const b = this.must(bookingId);
    const alerts = await this.#d.weather.alertsFor(b.date);
    return { alerts, explanation: alerts.length ? alerts.map(explainRisk).join(" ") : `No cyclone warning covers ${b.date}.` };
  }

  /** Tells every booking in a conversation whose date an alert covers (the demo control calls this). */
  async announceCyclone(conversationId: string): Promise<number> {
    let n = 0;
    for (const b of this.forConversation(conversationId)) {
      const { alerts, explanation } = await this.weatherFor(b.id);
      if (!alerts.length || !["captured", "order_created", "mandate_approved", "priced", "mandate_proposed"].includes(b.status)) continue;
      this.#log(b, "weather.alert", { alerts: alerts.map((a) => ({ id: a.id, level: a.level, from: a.from, to: a.to, source: a.source })) });
      this.#d.channels.emit(conversationId, { type: "cyclone", booking_id: b.id, text: `Cyclone warning for ${b.date}: ${explanation}` });
      n++;
    }
    return n;
  }

  proposeReschedule(bookingId: string, newDate: string): Booking {
    const b = this.must(bookingId);
    if (!DATE_RE.test(newDate) || newDate === b.date) throw new ServiceError("bad_date", "new_date must be YYYY-MM-DD and differ from the booking date.");
    if (b.status !== "captured") throw new ServiceError("wrong_state", `Only a paid booking can be moved (it is ${b.status}).`);
    if (b.reschedule?.status === "proposed") throw new ServiceError("pending", "A reschedule is already waiting for the guide.");
    const next = this.#save({ ...b, reschedule: { new_date: newDate, status: "proposed" } });
    this.#log(next, "reschedule.proposed", { from: b.date, to: newDate });
    return next;
  }

  answerReschedule(token: string, accept: boolean): Booking {
    const b = this.#byTokenOrThrow(token);
    if (b.reschedule?.status !== "proposed") throw new ServiceError("no_reschedule", "No reschedule is waiting.");
    const to = b.reschedule.new_date;
    const next = this.#save(accept ? { ...b, date: to, reschedule: { new_date: to, status: "accepted" } } : { ...b, reschedule: { new_date: to, status: "declined" } });
    this.#log(next, accept ? "reschedule.accepted" : "reschedule.declined", { from: b.date, to });
    this.#d.channels.emit(b.conversation_id, {
      type: "reschedule_answered",
      booking_id: b.id,
      text: accept ? `${b.guide_name} accepted the move to ${to}; the deposit carries over.` : `${b.guide_name} can't do ${to}. A refund of the deposit is now allowed.`,
    });
    return next;
  }

  /** The guide offers a refund from the operator page (e.g. they fell ill). */
  offerRefund(token: string): Booking {
    const b = this.#byTokenOrThrow(token);
    if (b.status !== "captured" && b.status !== "partially_refunded") throw new ServiceError("wrong_state", "Nothing to refund.");
    const next = this.#save({ ...b, refund_offered: true });
    this.#log(next, "refund.offered", {});
    this.#d.channels.emit(b.conversation_id, { type: "refund_offered", booking_id: b.id, text: `${b.guide_name} offered to refund the deposit.` });
    return next;
  }

  /** Why a refund is allowed now, or undefined. */
  async refundReason(b: Booking): Promise<string | undefined> {
    if (b.status !== "captured" && b.status !== "partially_refunded") return undefined;
    if (b.refund_offered) return "the guide offered it";
    if (b.reschedule?.status === "declined") return "the guide declined the reschedule";
    if ((await this.#d.weather.alertsFor(b.date)).some((a) => a.level !== "green")) return "a cyclone warning covers the date";
    return undefined;
  }

  /** Minor units completed, pending or still being sent: none of it may be refunded again. */
  static reservedMinor(b: Booking): number {
    return b.refund_ops.filter((o) => o.status !== "failed").reduce((s, o) => s + o.amount_minor, 0);
  }

  /**
   * Refunds part or all of the capture. Each refund is persisted (amount + PayPal-Request-Id) before it is
   * sent; if a send has no definitive answer, the next call resends that same operation unchanged.
   */
  async refund(bookingId: string, amount?: string): Promise<Booking> {
    return this.#serial(bookingId, async () => {
      let b = this.must(bookingId);
      let op = b.refund_ops.find((o) => o.status === "sending");
      if (op) {
        this.#log(b, "refund.retry", { n: op.n, request_id: op.request_id, amount_minor: op.amount_minor, requested: amount ?? null });
      } else {
        const reason = await this.refundReason(b);
        if (!reason) throw new ServiceError("refund_not_allowed", "A refund needs a cyclone warning (orange or red) on the date, a declined reschedule, or the guide's offer.");
        const capturedMinor = toMinor(b.captured!.value);
        const reserved = BookingService.reservedMinor(b);
        const left = capturedMinor - reserved;
        let minor = left;
        if (amount !== undefined) {
          try {
            minor = toMinor(amount);
          } catch {
            throw new ServiceError("bad_amount", "amount must look like 10.00.");
          }
        }
        if (minor <= 0 || minor > left) throw new ServiceError("bad_amount", `At most ${fromMinor(Math.max(0, left))} can be refunded now${reserved ? " (other refunds are pending or done)" : ""}.`);
        const n = b.refund_ops.length + 1;
        op = { n, request_id: `refund-${b.id}-${n}`, amount_minor: minor, full: minor === capturedMinor, reason, status: "sending" };
        b = this.#save({ ...b, refund_ops: [...b.refund_ops, op] });
        this.#log(b, "refund.requested", { n, request_id: op.request_id, amount: { currency_code: b.captured!.currency_code, value: fromMinor(minor) }, reason });
      }
      const cur = b.captured!.currency_code;
      const body = op.full ? {} : { amount: { currency_code: cur, value: fromMinor(op.amount_minor) } };
      let refund: Refund;
      try {
        refund = await this.#d.payments.refundCapture(b.capture_id!, { ...body, custom_id: b.id, note_to_payer: `Ambree: ${op.reason}.` }, op.request_id);
      } catch (e) {
        if (isDefinitive(e)) {
          const failed = this.#setOp(this.must(bookingId), op.n, { status: "failed" });
          this.#log(failed, "refund.failed", { n: op.n, error: (e as PayPalError).summary() });
        } else {
          this.#log(b, "refund.ambiguous", { n: op.n, error: e instanceof PayPalError ? e.kind : "unknown" });
        }
        throw e;
      }
      return this.#applyRefund(this.must(bookingId), op.n, refund);
    });
  }

  /** Asks PayPal about every pending refund (the PAYMENT.CAPTURE.REFUNDED webhook calls this). */
  async refreshRefunds(bookingId: string): Promise<Booking> {
    return this.#serial(bookingId, async () => {
      let b = this.must(bookingId);
      for (const op of b.refund_ops.filter((o) => o.status === "pending" && o.refund_id)) {
        b = this.#applyRefund(b, op.n, await this.#d.payments.getRefund(op.refund_id!));
      }
      return b;
    });
  }

  #setOp(b: Booking, n: number, patch: Partial<RefundOp>): Booking {
    return this.#save({ ...b, refund_ops: b.refund_ops.map((o) => (o.n === n ? { ...o, ...patch } : o)) });
  }

  #applyRefund(b: Booking, n: number, refund: Refund): Booking {
    const op = b.refund_ops.find((o) => o.n === n)!;
    const cur = b.captured!.currency_code;
    let actual = op.amount_minor;
    if (refund.amount) {
      const got = refund.amount.currency_code === cur ? toMinor(refund.amount.value) : -1;
      if (got !== op.amount_minor) {
        this.#log(b, "refund.reconcile_failed", { n, refund_id: refund.id, expected: { currency_code: cur, value: fromMinor(op.amount_minor) }, got: refund.amount });
        if (got >= 0) actual = got;
      }
    }
    if (refund.status === "COMPLETED") {
      const capturedMinor = toMinor(b.captured!.value);
      const refunded = b.refunded_minor + actual;
      const next = this.#setOp({ ...b, refunded_minor: refunded, refund_ids: [...b.refund_ids, refund.id], status: refunded >= capturedMinor ? "refunded" : "partially_refunded" }, n, { status: "completed", refund_id: refund.id, amount_minor: actual });
      this.#log(next, "refund.completed", { n, refund_id: refund.id, status: refund.status, amount: { currency_code: cur, value: fromMinor(actual) }, reason: op.reason });
      this.#d.channels.emit(b.conversation_id, { type: "refunded", booking_id: b.id, text: `Refunded ${cur} ${fromMinor(actual)} from ${b.guide_name} to the traveller (${op.reason}).` });
      return next;
    }
    if (refund.status === "PENDING") {
      const next = this.#setOp(b, n, { status: "pending", refund_id: refund.id, amount_minor: actual });
      if (op.status !== "pending") this.#log(next, "refund.pending", { n, refund_id: refund.id, amount: { currency_code: cur, value: fromMinor(actual) } });
      return next;
    }
    const next = this.#setOp(b, n, { status: "failed", refund_id: refund.id });
    this.#log(next, "refund.failed", { n, refund_id: refund.id, status: refund.status });
    return next;
  }

  /** What tools and the page may show of a booking: never the operator token or the mandate nonce. */
  summary(b: Booking): Record<string, unknown> {
    const m = this.mandateView(b);
    const pending = b.refund_ops.filter((o) => o.status === "pending" || o.status === "sending").reduce((s, o) => s + o.amount_minor, 0);
    return {
      booking_id: b.id,
      status: b.status,
      guide: { id: b.guide_id, name: b.guide_name },
      activity: b.activity,
      area: b.area,
      date: b.date,
      party_size: b.party_size,
      quote: b.quote ? { total: b.quote.total, deposit: b.quote.deposit, payee: payeeLabel(b.quote.payee), guide_note: b.quote.guide_note, quote_hash: b.quote_hash } : null,
      mandate: m ? { id: m.id, status: m.status, amount: m.amount, payee: payeeLabel(m.payee), expires_at: m.expires_at, quote_hash: m.quote_hash } : null,
      order: b.order_id ? { id: b.order_id, approve_url: b.approve_url ?? null } : null,
      capture: b.capture_id && b.captured ? { id: b.capture_id, amount: b.captured, status: b.capture_status ?? null } : b.capture_id ? { id: b.capture_id, amount: null, status: b.capture_status ?? null } : null,
      refunded: b.captured ? { currency_code: b.captured.currency_code, value: fromMinor(b.refunded_minor) } : null,
      refund_pending: b.captured && pending ? { currency_code: b.captured.currency_code, value: fromMinor(pending) } : null,
      reschedule: b.reschedule ?? null,
      refund_offered: b.refund_offered,
    };
  }
}
