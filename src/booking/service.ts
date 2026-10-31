// The booking service: the rules of "Book the guide". The agent's tools, the operator page, the PayPal
// return URL and the webhook endpoint all come through here, so the mandate check, payee pinning, refund
// policy and ledger writes hold whatever the model says. Money moves traveller → guide (the order's payee
// is the guide's own account) and back on a refund; it never passes through an Ambree account.

import { randomBytes } from "node:crypto";
import type { Guide } from "../guides/seed.ts";
import { sha256Hex } from "../ledger/canonical.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { type Mandate, type MandateView, type Mandates, type Quote, quoteHash, view } from "../mandate/mandate.ts";
import type { PaymentsApi } from "../paypal/api.ts";
import { PayPalError } from "../paypal/errors.ts";
import { formatMoney, fromMinor, toMinor } from "../paypal/money.ts";
import { type CurrencyCode, type Money, type Order, type Payee, type WebhookEvent, approveLink, firstCapture, transmissionFromHeaders } from "../paypal/types.ts";
import { type Db, Records, markWebhookSeen } from "../store/db.ts";
import { type CycloneAlert, type CycloneFeed, explainRisk } from "../weather/cyclones.ts";
import type { Channels } from "./channels.ts";

export type BookingStatus = "requested" | "priced" | "declined" | "mandate_proposed" | "mandate_approved" | "order_created" | "captured" | "partially_refunded" | "refunded";

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
  /** Set once the mandate is consumed, so a failed create can be retried with the same nonce. */
  order_pending?: boolean;
  order_id?: string;
  approve_url?: string;
  capture_id?: string;
  captured?: Money;
  refunded_minor: number;
  refund_ids: string[];
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
  now?: () => Date;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function hashToken(token: string): string {
  return sha256Hex(`operator:${token}`);
}

function payeeLabel(p: Payee): string {
  return p.email_address ?? `merchant ${p.merchant_id}`;
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
    if (!b) throw new ServiceError("not_found", `No booking ${String(id).slice(0, 40)}.`);
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

  /** The traveller approves with the step-up code. Only the web route calls this; no tool does. */
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

  /** Creates the PayPal order with the guide as payee, only inside an approved, unused mandate. */
  async createOrder(bookingId: string): Promise<Booking> {
    return this.#serial(bookingId, async () => {
      const b = this.must(bookingId);
      if (b.order_id) return b;
      if (b.status !== "mandate_approved") throw new ServiceError("no_mandate", `No approved mandate (the booking is ${b.status}). Propose one and wait for the traveller.`);
      const g = this.guide(b.guide_id)!;
      let m: Mandate;
      if (b.order_pending) {
        m = this.#d.mandates.get(b.mandate_id!)!;
      } else {
        const r = this.#d.mandates.consume(b.mandate_id!, { quote: b.quote!, amount: b.quote!.deposit, payee: g.payee });
        if (!r.ok) {
          this.#log(b, "order.refused", { mandate_id: b.mandate_id, reason: r.reason });
          throw new ServiceError(r.reason, r.message);
        }
        m = r.value;
        this.#save({ ...b, order_pending: true });
      }
      const order = await this.#d.payments.createOrder(
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
      const url = approveLink(order);
      const next = this.#save({ ...this.must(bookingId), status: "order_created", order_pending: false, order_id: order.id, approve_url: url });
      this.#log(next, "order.created", { order_id: order.id, status: order.status, amount: m.amount, payee: order.purchase_units?.[0]?.payee ?? m.payee, mandate_id: m.id, quote_hash: m.quote_hash });
      return next;
    });
  }

  async getOrder(bookingId: string): Promise<Order> {
    const b = this.must(bookingId);
    if (!b.order_id) throw new ServiceError("no_order", "No PayPal order yet.");
    return this.#d.payments.getOrder(b.order_id);
  }

  /** Captures once the buyer approved; idempotent (return URL, webhook and tool may all call it). */
  async captureIfApproved(bookingId: string): Promise<{ booking: Booking; captured: boolean; order_status: string }> {
    return this.#serial(bookingId, async () => {
      const b = this.must(bookingId);
      if (b.capture_id) return { booking: b, captured: true, order_status: "COMPLETED" };
      if (!b.order_id) throw new ServiceError("no_order", "No PayPal order yet.");
      let order = await this.#d.payments.getOrder(b.order_id);
      if (order.status === "APPROVED") {
        try {
          order = await this.#d.payments.captureOrder(order.id, `capture-${order.id}`);
        } catch (e) {
          if (!(e instanceof PayPalError && e.issue === "ORDER_ALREADY_CAPTURED")) throw e;
          order = await this.#d.payments.getOrder(b.order_id);
        }
      }
      const cap = firstCapture(order);
      if (order.status !== "COMPLETED" || !cap) return { booking: b, captured: false, order_status: order.status };
      const next = this.#save({ ...b, status: cap.status === "COMPLETED" ? "captured" : b.status, capture_id: cap.id, captured: cap.amount });
      this.#log(next, "capture.completed", { order_id: order.id, capture_id: cap.id, status: cap.status, amount: cap.amount, payee: order.purchase_units?.[0]?.payee, payer_id: order.payer?.payer_id });
      this.#d.channels.emit(b.conversation_id, { type: "paid", booking_id: b.id, text: `Paid: ${formatMoney(cap.amount)} went to ${b.guide_name}'s PayPal (capture ${cap.id}). The spot is held for ${b.date}.` });
      return { booking: next, captured: true, order_status: order.status };
    });
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
    return id ? this.#bookings.list().find((b) => b.order_id === id || b.capture_id === id || b.refund_ids.includes(id)) : undefined;
  }

  /** POST /webhooks/paypal: verify with PayPal, dedupe, log, react. Returns the HTTP status to send. */
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
    if (!markWebhookSeen(this.#d.db, event.id, event.event_type, this.#now().toISOString())) return { status: 200, result: "duplicate" };
    const b = this.#findForResource(event.resource);
    if (!b) return { status: 200, result: "no matching booking" };
    const r = event.resource as { id?: string; status?: string; amount?: Money };
    this.#log(b, `webhook.${event.event_type}`, { event_id: event.id, resource_type: event.resource_type, resource_id: r.id, status: r.status, amount: r.amount, verified: true });
    if (event.event_type === "CHECKOUT.ORDER.APPROVED") await this.captureIfApproved(b.id);
    return { status: 200, result: "logged" };
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

  async refund(bookingId: string, amount?: string): Promise<Booking> {
    return this.#serial(bookingId, async () => {
      const b = this.must(bookingId);
      const reason = await this.refundReason(b);
      if (!reason) throw new ServiceError("refund_not_allowed", "A refund needs a cyclone warning (orange or red) on the date, a declined reschedule, or the guide's offer.");
      const capturedMinor = toMinor(b.captured!.value);
      const left = capturedMinor - b.refunded_minor;
      let minor = left;
      if (amount !== undefined) {
        try {
          minor = toMinor(amount);
        } catch {
          throw new ServiceError("bad_amount", "amount must look like 10.00.");
        }
        if (minor <= 0 || minor > left) throw new ServiceError("bad_amount", `At most ${fromMinor(left)} can be refunded.`);
      }
      const cur = b.captured!.currency_code;
      const n = b.refund_ids.length + 1;
      const body = minor === left && b.refunded_minor === 0 ? {} : { amount: { currency_code: cur, value: fromMinor(minor) } };
      const refund = await this.#d.payments.refundCapture(b.capture_id!, { ...body, custom_id: b.id, note_to_payer: `Ambree: ${reason}.` }, `refund-${b.id}-${n}`);
      const refunded = b.refunded_minor + minor;
      const next = this.#save({ ...b, refunded_minor: refunded, refund_ids: [...b.refund_ids, refund.id], status: refunded >= capturedMinor ? "refunded" : "partially_refunded" });
      this.#log(next, "refund.completed", { refund_id: refund.id, status: refund.status, amount: { currency_code: cur, value: fromMinor(minor) }, reason });
      this.#d.channels.emit(b.conversation_id, { type: "refunded", booking_id: b.id, text: `Refunded ${cur} ${fromMinor(minor)} from ${b.guide_name} to the traveller (${reason}).` });
      return next;
    });
  }

  /** What tools and the page may show of a booking: never the operator token or the mandate nonce. */
  summary(b: Booking): Record<string, unknown> {
    const m = this.mandateView(b);
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
      capture: b.capture_id ? { id: b.capture_id, amount: b.captured } : null,
      refunded: b.captured ? { currency_code: b.captured.currency_code, value: fromMinor(b.refunded_minor) } : null,
      reschedule: b.reschedule ?? null,
      refund_offered: b.refund_offered,
    };
  }
}
