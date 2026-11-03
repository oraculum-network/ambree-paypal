// An in-process stand-in for the PayPal sandbox: a `fetch` that answers the same paths with the same JSON
// shapes as Orders v2, Payments v2 refunds, OAuth and webhook verification. PayPalRestClient runs against it
// unchanged, so tests and the offline demo exercise the real client code. It also plays the buyer
// (approve) and PayPal's webhook sender (deliver), and keeps payee balances so the demo can show the
// guide being paid. Shapes marked UNVERIFIED in DESIGN.md are this fake's best guess until the spike.
//
// Several REST apps (DESIGN.md §21, D5), as the sandbox showed on 3 Nov: each has a client id and secret and
// an owner merchant id, and the bearer token says which app calls. The options' own clientId/secret/owner
// are the default app (the operator's); `apps` adds more (a guide's own). An order with no payee is paid to
// the calling app's owner. Only the app owned by a capture's payee may refund it or read its refunds: anyone
// else gets 403 NOT_AUTHORIZED / PERMISSION_DENIED and nothing moves. The capture may be read by its order's
// creator and by its payee. Idempotency (PayPal-Request-Id) is per app.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fromMinor, isCurrency, toMinor } from "./money.ts";
import { SANDBOX_API_BASE } from "./sandbox.ts";
import type { Capture, CreateOrderRequest, Link, Order, Payee, Refund, WebhookEvent } from "./types.ts";
import { WEBHOOK_HEADERS } from "./types.ts";

/** One fake REST app. */
export interface FakeAppOptions {
  clientId: string;
  clientSecret: string;
  /** The account that owns the app: a no-payee order is paid to it; it alone refunds captures paid to it. */
  ownerMerchantId: string;
  /** The same account's email addresses: a payee given by one of these is this owner. */
  ownerEmails?: string[];
  /** The app's own webhook id. Default WH-FAKE-{owner}. */
  webhookId?: string;
}

/** What the fake shows of an app (never its secret). */
export interface FakeApp {
  clientId: string;
  ownerMerchantId: string;
  webhookId: string;
}

/** A guide's own fake app, owned by `ownerMerchantId`: fixed, low-value credentials, so a test can rebuild them. */
export function fakeAppFor(ownerMerchantId: string): FakeAppOptions {
  const m = ownerMerchantId.toLowerCase();
  return { clientId: `fake-app-${m}`, clientSecret: `fake-app-secret-${m}`, ownerMerchantId, webhookId: `WH-FAKE-${ownerMerchantId}` };
}

interface AppState {
  clientId: string;
  clientSecret: string;
  owner: string;
  emails: Set<string>;
  webhookId: string;
}

export interface FakePayPalOptions {
  /** The default app (the operator's): its client id, secret and webhook id. */
  clientId?: string;
  clientSecret?: string;
  webhookId?: string;
  /** More apps (e.g. each guide's own), with the default app's rules. */
  apps?: FakeAppOptions[];
  /** Where the approve link points. The demo server serves its own stand-in checkout page there. */
  checkoutUrl?: string;
  /** The merchant id that owns the fake REST app: an order with no payee is paid to it (and echoes it). Default AMBREEOPER001. */
  ownerMerchantId?: string;
  /** If set, only these payee emails / merchant ids are accepted. */
  knownPayees?: string[];
  tokenTtlSeconds?: number;
  now?: () => Date;
  /** Receives each webhook as PayPal would POST it: the raw body and the PAYPAL-* headers. */
  deliver?: (rawBody: string, headers: Record<string, string>) => Promise<void> | void;
}

interface StoredOrder {
  order: Order;
  payeeKey: string;
  /** The client id of the app that created it. */
  creator: string;
}

interface Failure {
  method?: string;
  path: RegExp;
  status: number;
  body?: unknown;
  /** Never answer (the client's timeout fires). */
  hang?: boolean;
  /** Throw like a dropped connection. */
  network?: boolean;
  /**
   * Process the request normally, then lose the reply: with `status` 0 the client sees a network error; with a
   * 5xx `status` it gets that error instead (PayPal processed the request, then failed to say so).
   */
  dropResponse?: boolean;
  /** Answer as PayPal normally would (no failure); useful with `wait`. */
  pass?: boolean;
  /** Hold this request until the promise settles, then answer it as the other fields say. */
  wait?: Promise<unknown>;
  /**
   * With `pass` or `dropResponse`: process the request at once (its webhook is sent then), but hold the
   * reply (or its loss) until the promise settles.
   */
  replyAfter?: Promise<unknown>;
}

export const FAKE_CLIENT_ID = "fake-client-id";
export const FAKE_CLIENT_SECRET = "fake-client-secret";
export const FAKE_WEBHOOK_ID = "WH-FAKE-0001";

const UNPROCESSABLE = "The requested action could not be performed, semantically incorrect, or failed business validation.";

function payeeKey(p: Payee | undefined): string {
  if (!p) return "app-owner";
  return p.email_address ? `email:${p.email_address.toLowerCase()}` : `merchant:${p.merchant_id}`;
}

function newId(prefix = ""): string {
  return prefix + randomBytes(9).toString("hex").toUpperCase().slice(0, 17 - prefix.length);
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function ppError(status: number, name: string, issue: string, description: string): Response {
  return json(status, { name, message: status === 422 ? UNPROCESSABLE : description, debug_id: newId("D").toLowerCase(), details: [{ issue, description }] });
}

/** What the sandbox answered the operator's app refunding (or reading a refund of) the guide's capture, 3 Nov. */
function denied(): Response {
  return ppError(403, "NOT_AUTHORIZED", "PERMISSION_DENIED", "Authorization failed due to insufficient permissions.");
}

export class FakePayPal {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookId: string;
  /** Every request: `app` is the client id of the app whose token it carried (none for the token request). */
  readonly calls: Array<{ method: string; path: string; status: number; requestId?: string; app?: string }> = [];
  readonly sentWebhooks: WebhookEvent[] = [];
  readonly fetch: typeof fetch;
  deliver: FakePayPalOptions["deliver"];
  /**
   * `false` models a PayPal that does NOT dedupe a repeated PayPal-Request-Id: every request is processed as
   * a new one, so the client's own retry or the service's resend of a refund makes another refund (the
   * premise of round 9's R9-1 and R9-4; UNVERIFIED either way, DESIGN.md §19). Default true: the same id on
   * the same path replays the first reply.
   */
  dedupe = true;
  /**
   * `false`: refund resources (the POST reply, GET, and every refund webhook) carry no `custom_id`, only
   * their `up` link to the capture (R9-2, R9-5; UNVERIFIED, §19).
   */
  refundCustomId = true;
  /**
   * `false`: refund resources carry no `seller_payable_breakdown`. Default true: `total_refunded_amount` is
   * the capture's completed refunds at the moment the resource is produced (a PENDING refund isn't in it).
   * The real field's semantics are UNVERIFIED (§19).
   */
  refundTotals = true;

  readonly #opts: FakePayPalOptions;
  readonly #orders = new Map<string, StoredOrder>();
  readonly #captures = new Map<string, { capture: Capture; orderId: string; refundedMinor: number }>();
  readonly #refunds = new Map<string, Refund>();
  /** Each refund's capture. */
  readonly #refundCapture = new Map<string, string>();
  /** Refunds created PENDING (pendNextRefund): what each holds on its capture until it settles. */
  readonly #pendingRefunds = new Map<string, { captureId: string; minor: number }>();
  #pendNext = 0;
  readonly #idem = new Map<string, { status: number; body: unknown }>();
  /** Each token's expiry and app (client id). */
  readonly #tokens = new Map<string, { exp: number; app: string }>();
  /** The apps by client id; the first is the default app. */
  readonly #apps = new Map<string, AppState>();
  readonly #balances = new Map<string, number>();
  readonly #failures: Failure[] = [];
  readonly #signingKey = randomBytes(32);
  readonly #transmissions = new Map<string, string>();
  #deliveries: Promise<unknown> = Promise.resolve();

  constructor(opts: FakePayPalOptions = {}) {
    this.#opts = opts;
    this.clientId = opts.clientId ?? FAKE_CLIENT_ID;
    this.clientSecret = opts.clientSecret ?? FAKE_CLIENT_SECRET;
    this.webhookId = opts.webhookId ?? FAKE_WEBHOOK_ID;
    this.deliver = opts.deliver;
    this.fetch = ((input: string | URL | Request, init?: RequestInit) => this.#handle(input, init)) as typeof fetch;
    this.addApp({ clientId: this.clientId, clientSecret: this.clientSecret, ownerMerchantId: opts.ownerMerchantId ?? "AMBREEOPER001", webhookId: this.webhookId });
    for (const a of opts.apps ?? []) this.addApp(a);
  }

  // ---------- test and demo controls ----------

  /** Registers another REST app (e.g. a guide's own). Its client id must be new. */
  addApp(a: FakeAppOptions): FakeApp {
    if (this.#apps.has(a.clientId)) throw new Error(`fake: app ${a.clientId} is already registered`);
    const app: AppState = { clientId: a.clientId, clientSecret: a.clientSecret, owner: a.ownerMerchantId, emails: new Set((a.ownerEmails ?? []).map((e) => e.toLowerCase())), webhookId: a.webhookId ?? `WH-FAKE-${a.ownerMerchantId}` };
    this.#apps.set(app.clientId, app);
    return FakePayPal.#view(app);
  }

  /** The apps, default (the operator's) first, without their secrets. */
  apps(): FakeApp[] {
    return [...this.#apps.values()].map(FakePayPal.#view);
  }

  static #view(a: AppState): FakeApp {
    return { clientId: a.clientId, ownerMerchantId: a.owner, webhookId: a.webhookId };
  }

  /** Whether `app`'s owner is the account behind payee key `key` (its merchant id, or one of its emails). */
  #owns(app: AppState, key: string): boolean {
    return key === `merchant:${app.owner}` || (key.startsWith("email:") && app.emails.has(key.slice("email:".length)));
  }

  /** The app whose bearer token the headers carry, if it is a live one. */
  #caller(headers: Headers): AppState | undefined {
    const auth = headers.get("Authorization") ?? "";
    const t = auth.startsWith("Bearer ") ? this.#tokens.get(auth.slice(7)) : undefined;
    return t && t.exp >= Date.now() ? this.#apps.get(t.app) : undefined;
  }

  /** The next request matching `path` (and `method`) fails this way. */
  failNext(f: Failure): void {
    this.#failures.push(f);
  }

  /**
   * The next refund PayPal creates is PENDING: its amount is held on the capture (so a further refund can't
   * exceed what's left) but no money moves until settleRefund. Its creation sends no webhook.
   */
  pendNextRefund(): void {
    this.#pendNext++;
  }

  /**
   * PayPal settles a PENDING refund: COMPLETED moves the money (PAYMENT.CAPTURE.REFUNDED), FAILED releases
   * what it held on the capture (PAYMENT.REFUND.FAILED). GET then shows the new status; a replayed POST
   * reply (same PayPal-Request-Id) still shows the PENDING one it first sent.
   */
  settleRefund(refundId: string, status: "COMPLETED" | "FAILED"): void {
    const held = this.#pendingRefunds.get(refundId);
    const r = this.#refunds.get(refundId);
    if (!held || !r) throw new Error(`fake: no pending refund ${refundId}`);
    this.#pendingRefunds.delete(refundId);
    const c = this.#captures.get(held.captureId)!;
    const capturedMinor = toMinor(c.capture.amount.value);
    r.status = status;
    if (status === "COMPLETED") {
      const stored = this.#orders.get(c.orderId)!;
      this.#balances.set(stored.payeeKey, (this.#balances.get(stored.payeeKey) ?? 0) - held.minor);
      this.#emit("PAYMENT.CAPTURE.REFUNDED", "refund", this.#refundView(r), `A ${r.amount!.currency_code} ${r.amount!.value} capture payment was refunded`);
    } else {
      c.refundedMinor -= held.minor;
      c.capture.status = c.refundedMinor <= 0 ? "COMPLETED" : c.refundedMinor >= capturedMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
      this.#emit("PAYMENT.REFUND.FAILED", "refund", this.#refundView(r), `A ${r.amount!.currency_code} ${r.amount!.value} refund failed`);
    }
  }

  /**
   * A refund as PayPal shows it now (reply, GET, webhook): without `custom_id` when `refundCustomId` is off,
   * and with `seller_payable_breakdown` (the capture's completed refunds so far) when `refundTotals` is on.
   */
  #refundView(r: Refund): Refund {
    const out = structuredClone(r);
    if (!this.refundCustomId) delete out.custom_id;
    const captureId = this.#refundCapture.get(r.id);
    if (this.refundTotals && captureId && out.amount) {
      out.seller_payable_breakdown = { gross_amount: { ...out.amount }, total_refunded_amount: { currency_code: out.amount.currency_code, value: fromMinor(this.refundedFrom(captureId)) } };
    }
    return out;
  }

  /** The ids of the refunds PayPal made, oldest first (whatever their status). */
  refundIds(): string[] {
    return [...this.#refunds.keys()];
  }

  /** Money refunded from a capture so far (completed refunds only), in minor units. */
  refundedFrom(captureId: string): number {
    const c = this.#captures.get(captureId);
    if (!c) return 0;
    const held = [...this.#pendingRefunds.values()].filter((p) => p.captureId === captureId).reduce((s, p) => s + p.minor, 0);
    return c.refundedMinor - held;
  }

  /** Expires every issued token (the client should refresh on the 401). */
  expireTokens(): void {
    this.#tokens.clear();
  }

  /** The buyer logs in and approves the order in checkout. */
  approve(orderId: string, payer = { email_address: "traveller@personal.sandbox.example", payer_id: "FAKEBUYER0001" }): Order {
    const stored = this.#orders.get(orderId);
    if (!stored) throw new Error(`fake: no order ${orderId}`);
    if (stored.order.status !== "CREATED" && stored.order.status !== "PAYER_ACTION_REQUIRED") {
      throw new Error(`fake: order ${orderId} is ${stored.order.status}, not approvable`);
    }
    stored.order.status = "APPROVED";
    stored.order.payer = { ...payer, name: { given_name: "Sandbox", surname: "Traveller" } };
    stored.order.update_time = this.#now();
    this.#emit("CHECKOUT.ORDER.APPROVED", "checkout-order", structuredClone(stored.order), `An order was approved by the buyer`);
    return structuredClone(stored.order);
  }

  /** Changes a stored order out of band (as a PATCH by someone else would). */
  mutateOrder(orderId: string, fn: (o: Order) => void): void {
    const stored = this.#orders.get(orderId);
    if (!stored) throw new Error(`fake: no order ${orderId}`);
    fn(stored.order);
    stored.payeeKey = payeeKey(stored.order.purchase_units?.[0]?.payee);
  }

  order(orderId: string): Order | undefined {
    const o = this.#orders.get(orderId)?.order;
    return o ? structuredClone(o) : undefined;
  }

  /** Funds received by a payee (email or merchant id), in minor units, after refunds. */
  balance(payee: Payee): number {
    return this.#balances.get(payeeKey(payee)) ?? 0;
  }

  /** Resolves once every webhook queued so far has been handed to `deliver`. */
  async flush(): Promise<void> {
    let last: Promise<unknown>;
    do {
      last = this.#deliveries;
      await last;
    } while (last !== this.#deliveries);
  }

  // ---------- the HTTP surface ----------

  #now(): string {
    return (this.#opts.now?.() ?? new Date()).toISOString();
  }

  async #handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const requestId = headers.get("PayPal-Request-Id") ?? undefined;
    if (url.origin !== SANDBOX_API_BASE) throw new TypeError(`fake PayPal: unexpected host ${url.host}`);
    const app = this.#caller(headers)?.clientId;

    const failure = this.#failures.findIndex((f) => f.path.test(url.pathname) && (!f.method || f.method === method));
    if (failure >= 0) {
      const f = this.#failures.splice(failure, 1)[0]!;
      if (f.wait) await f.wait.catch(() => undefined);
      if (f.pass) {
        const res = await this.#route(method, url.pathname, headers, typeof init?.body === "string" ? init.body : undefined, requestId);
        this.calls.push({ method, path: url.pathname, status: res.status, requestId, app });
        if (f.replyAfter) await f.replyAfter.catch(() => undefined);
        return res;
      }
      if (f.hang) {
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      if (f.network) throw new TypeError("fetch failed");
      if (f.dropResponse) {
        const lost = await this.#route(method, url.pathname, headers, typeof init?.body === "string" ? init.body : undefined, requestId);
        this.calls.push({ method, path: url.pathname, status: lost.status, requestId, app });
        if (f.replyAfter) await f.replyAfter.catch(() => undefined);
        if (f.status >= 500) return json(f.status, f.body ?? { name: "INTERNAL_SERVER_ERROR", message: "An internal server error occurred.", debug_id: newId("D").toLowerCase(), details: [] });
        throw new TypeError("fetch failed");
      }
      this.calls.push({ method, path: url.pathname, status: f.status, requestId, app });
      return json(f.status, f.body);
    }

    const res = await this.#route(method, url.pathname, headers, typeof init?.body === "string" ? init.body : undefined, requestId);
    this.calls.push({ method, path: url.pathname, status: res.status, requestId, app });
    return res;
  }

  async #route(method: string, path: string, headers: Headers, rawBody: string | undefined, requestId: string | undefined): Promise<Response> {
    if (method === "POST" && path === "/v1/oauth2/token") return this.#token(headers, rawBody);

    const caller = this.#caller(headers);
    if (!caller) return json(401, { error: "invalid_token", error_description: "Token signature verification failed" });

    let body: Record<string, unknown> = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return ppError(400, "INVALID_REQUEST", "MALFORMED_REQUEST_JSON", "The request JSON is not well formed.");
      }
    }

    // Idempotency: the same PayPal-Request-Id on the same path, from the same app, replays the first reply
    // (unless `dedupe` is off). Another app's request is its own, even under the same id.
    const idemKey = requestId && this.dedupe ? `${caller.clientId} ${method} ${path} ${requestId}` : undefined;
    if (idemKey && this.#idem.has(idemKey)) {
      const prior = this.#idem.get(idemKey)!;
      return json(prior.status, prior.body);
    }
    const res = this.#dispatch(method, path, body, caller);
    if (idemKey && res.status < 500) {
      const copy = res.clone();
      this.#idem.set(idemKey, { status: copy.status, body: await copy.json().catch(() => undefined) });
    }
    return res;
  }

  #token(headers: Headers, rawBody: string | undefined): Response {
    const auth = headers.get("Authorization") ?? "";
    const app = [...this.#apps.values()].find((a) => auth === `Basic ${Buffer.from(`${a.clientId}:${a.clientSecret}`).toString("base64")}`);
    if (!app) return json(401, { error: "invalid_client", error_description: "Client Authentication failed" });
    if (new URLSearchParams(rawBody ?? "").get("grant_type") !== "client_credentials") {
      return json(400, { error: "unsupported_grant_type", error_description: "Grant Type is NULL" });
    }
    const ttl = this.#opts.tokenTtlSeconds ?? 32_400;
    const accessToken = `A21AA${randomBytes(24).toString("base64url")}`;
    this.#tokens.set(accessToken, { exp: Date.now() + ttl * 1000, app: app.clientId });
    return json(200, { scope: "https://uri.paypal.com/services/payments/payment", access_token: accessToken, token_type: "Bearer", app_id: "APP-FAKE0001", expires_in: ttl, nonce: randomUUID() });
  }

  #dispatch(method: string, path: string, body: Record<string, unknown>, caller: AppState): Response {
    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/v2/checkout/orders") return this.#createOrder(body as unknown as CreateOrderRequest, caller);
    if (method === "GET" && (m = path.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) {
      const o = this.#orders.get(m[1]!);
      return o ? json(200, o.order) : ppError(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
    }
    if (method === "POST" && (m = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/))) return this.#capture(m[1]!);
    if (method === "GET" && (m = path.match(/^\/v2\/payments\/captures\/([^/]+)$/))) {
      // As the spike saw it (3 Nov): status, amount and links self/refund/up; no refunded total. Readable by
      // the order's creator and by the payee (both apps could), no one else.
      const c = this.#captures.get(m[1]!);
      if (!c) return ppError(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
      const stored = this.#orders.get(c.orderId)!;
      return stored.creator === caller.clientId || this.#owns(caller, stored.payeeKey) ? json(200, c.capture) : denied();
    }
    if (method === "POST" && (m = path.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/))) return this.#refund(m[1]!, body, caller);
    if (method === "GET" && (m = path.match(/^\/v2\/payments\/refunds\/([^/]+)$/))) {
      // Only the payee's own app reads a refund of its capture (the operator's got 403, 3 Nov).
      const r = this.#refunds.get(m[1]!);
      if (!r) return ppError(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
      const stored = this.#orders.get(this.#captures.get(this.#refundCapture.get(r.id)!)!.orderId)!;
      return this.#owns(caller, stored.payeeKey) ? json(200, this.#refundView(r)) : denied();
    }
    if (method === "POST" && path === "/v1/notifications/verify-webhook-signature") return this.#verify(body);
    // No userinfo: the spike (S11) found it has no payer_id for an app token; the app owner comes from the
    // payee echo of an order with no payee (#createOrder), as at PayPal.
    return ppError(404, "NOT_FOUND", "INVALID_RESOURCE_ID", "The specified resource does not exist.");
  }

  #createOrder(body: CreateOrderRequest, caller: AppState): Response {
    const invalid = (issue: string, description: string) => ppError(400, "INVALID_REQUEST", issue, description);
    if (body.intent !== "CAPTURE") return invalid("INVALID_PARAMETER_VALUE", "intent must be CAPTURE in this fake.");
    const units = body.purchase_units;
    if (!Array.isArray(units) || units.length !== 1) return invalid("INVALID_ARRAY_MAX_ITEMS", "This fake takes exactly one purchase unit.");
    const unit = units[0]!;
    if (!unit.amount || !isCurrency(unit.amount.currency_code)) return invalid("CURRENCY_NOT_SUPPORTED", "Currency code is not supported.");
    let minor: number;
    try {
      minor = toMinor(unit.amount.value);
    } catch {
      return invalid("INVALID_PARAMETER_SYNTAX", "amount.value is not a valid amount.");
    }
    if (minor <= 0) return ppError(422, "UNPROCESSABLE_ENTITY", "AMOUNT_NOT_POSITIVE", "Amount must be greater than zero.");
    // No payee: PayPal pays the calling app's owner, and the reply echoes it (spike, 3 Nov; D3's identity probe).
    const payee: Payee = unit.payee ?? { merchant_id: caller.owner };
    const key = payeeKey(payee);
    const known = this.#opts.knownPayees;
    if (unit.payee && known && !known.some((k) => key === `email:${k.toLowerCase()}` || key === `merchant:${k}`)) {
      return ppError(422, "UNPROCESSABLE_ENTITY", "PAYEE_ACCOUNT_INVALID", "Payee account specified is invalid.");
    }
    const id = newId();
    const usesPaymentSource = Boolean(body.payment_source?.paypal);
    const checkout = this.#opts.checkoutUrl ?? "https://www.sandbox.paypal.com/checkoutnow";
    const links: Link[] = [
      { href: `${SANDBOX_API_BASE}/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
      { href: `${checkout}?token=${id}`, rel: usesPaymentSource ? "payer-action" : "approve", method: "GET" },
      { href: `${SANDBOX_API_BASE}/v2/checkout/orders/${id}`, rel: "update", method: "PATCH" },
      { href: `${SANDBOX_API_BASE}/v2/checkout/orders/${id}/capture`, rel: "capture", method: "POST" },
    ];
    const order: Order = {
      id,
      intent: "CAPTURE",
      status: usesPaymentSource ? "PAYER_ACTION_REQUIRED" : "CREATED",
      purchase_units: [{ ...structuredClone(unit), payee: structuredClone(payee), reference_id: unit.reference_id ?? "default", amount: { currency_code: unit.amount.currency_code, value: fromMinor(minor) } }],
      create_time: this.#now(),
      links,
    };
    this.#orders.set(id, { order, payeeKey: key, creator: caller.clientId });
    return json(201, order);
  }

  #capture(orderId: string): Response {
    const stored = this.#orders.get(orderId);
    if (!stored) return ppError(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
    const o = stored.order;
    if (o.status === "COMPLETED") return ppError(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED", "Order already captured.");
    if (o.status !== "APPROVED") return ppError(422, "UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.");
    const unit = o.purchase_units![0]!;
    const captureId = newId("C");
    const capture: Capture = {
      id: captureId,
      status: "COMPLETED",
      amount: unit.amount,
      final_capture: true,
      custom_id: unit.custom_id,
      invoice_id: unit.invoice_id,
      create_time: this.#now(),
      links: [
        { href: `${SANDBOX_API_BASE}/v2/payments/captures/${captureId}`, rel: "self", method: "GET" },
        { href: `${SANDBOX_API_BASE}/v2/payments/captures/${captureId}/refund`, rel: "refund", method: "POST" },
        { href: `${SANDBOX_API_BASE}/v2/checkout/orders/${orderId}`, rel: "up", method: "GET" },
      ],
    };
    unit.payments = { captures: [capture] };
    o.status = "COMPLETED";
    o.update_time = this.#now();
    this.#captures.set(captureId, { capture, orderId, refundedMinor: 0 });
    this.#balances.set(stored.payeeKey, (this.#balances.get(stored.payeeKey) ?? 0) + toMinor(unit.amount.value));
    this.#emit("PAYMENT.CAPTURE.COMPLETED", "capture", structuredClone(capture), `Payment completed for ${unit.amount.currency_code} ${unit.amount.value}`);
    return json(201, o);
  }

  #refund(captureId: string, body: Record<string, unknown>, caller: AppState): Response {
    const c = this.#captures.get(captureId);
    if (!c) return ppError(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
    // Only the payee's own app may refund its capture; the operator's app got 403 on 3 Nov. Nothing moves.
    if (!this.#owns(caller, this.#orders.get(c.orderId)!.payeeKey)) return denied();
    const capturedMinor = toMinor(c.capture.amount.value);
    const left = capturedMinor - c.refundedMinor;
    if (left <= 0) return ppError(422, "UNPROCESSABLE_ENTITY", "CAPTURE_FULLY_REFUNDED", "The capture has already been fully refunded.");
    const amount = body.amount as { currency_code?: unknown; value?: unknown } | undefined;
    let minor = left;
    if (amount !== undefined) {
      if (amount.currency_code !== c.capture.amount.currency_code) return ppError(422, "UNPROCESSABLE_ENTITY", "REFUND_CURRENCY_MISMATCH", "Refund must be in the currency of the capture.");
      try {
        minor = toMinor(String(amount.value));
      } catch {
        return ppError(400, "INVALID_REQUEST", "INVALID_PARAMETER_SYNTAX", "amount.value is not a valid amount.");
      }
      if (minor <= 0 || minor > left) return ppError(422, "UNPROCESSABLE_ENTITY", "REFUND_AMOUNT_EXCEEDED", "The refund amount must be less than or equal to the capture amount that has not yet been refunded.");
    }
    const pending = this.#pendNext > 0;
    if (pending) this.#pendNext--;
    c.refundedMinor += minor;
    c.capture.status = c.refundedMinor >= capturedMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
    const stored = this.#orders.get(c.orderId)!;
    if (!pending) this.#balances.set(stored.payeeKey, (this.#balances.get(stored.payeeKey) ?? 0) - minor);
    const refundId = newId("R");
    const refund: Refund = {
      id: refundId,
      status: pending ? "PENDING" : "COMPLETED",
      amount: { currency_code: c.capture.amount.currency_code, value: fromMinor(minor) },
      ...(typeof body.custom_id === "string" ? { custom_id: body.custom_id } : c.capture.custom_id ? { custom_id: c.capture.custom_id } : {}),
      ...(typeof body.note_to_payer === "string" ? { note_to_payer: body.note_to_payer } : {}),
      create_time: this.#now(),
      links: [
        { href: `${SANDBOX_API_BASE}/v2/payments/refunds/${refundId}`, rel: "self", method: "GET" },
        { href: `${SANDBOX_API_BASE}/v2/payments/captures/${captureId}`, rel: "up", method: "GET" },
      ],
    };
    this.#refunds.set(refundId, refund);
    this.#refundCapture.set(refundId, captureId);
    if (pending) this.#pendingRefunds.set(refundId, { captureId, minor });
    else this.#emit("PAYMENT.CAPTURE.REFUNDED", "refund", this.#refundView(refund), `A ${refund.amount!.currency_code} ${refund.amount!.value} capture payment was refunded`);
    return json(201, this.#refundView(refund));
  }

  // ---------- webhooks ----------

  #sign(transmissionId: string, time: string, event: unknown): string {
    return createHmac("sha256", this.#signingKey).update(`${transmissionId}|${time}|${this.webhookId}|${JSON.stringify(event)}`).digest("base64");
  }

  /** Sends a signed webhook of any type (e.g. PAYMENT.REFUND.FAILED), as PayPal would on its own. */
  emitWebhook(eventType: string, resourceType: string, resource: object): void {
    this.#emit(eventType, resourceType, structuredClone(resource), `${eventType} (fake)`);
  }

  #emit(eventType: string, resourceType: string, resource: object, summary: string): void {
    const event: WebhookEvent = {
      id: `WH-${newId()}`,
      event_version: "1.0",
      create_time: this.#now(),
      resource_type: resourceType,
      resource_version: "2.0",
      event_type: eventType,
      summary,
      resource: resource as Record<string, unknown>,
      links: [],
    };
    this.sentWebhooks.push(event);
    const deliver = this.deliver;
    if (!deliver) return;
    const transmissionId = randomUUID();
    const time = this.#now();
    const sig = this.#sign(transmissionId, time, event);
    this.#transmissions.set(transmissionId, sig);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [WEBHOOK_HEADERS.auth_algo]: "SHA256withRSA",
      [WEBHOOK_HEADERS.cert_url]: `${SANDBOX_API_BASE}/v1/notifications/certs/CERT-FAKE-0001`,
      [WEBHOOK_HEADERS.transmission_id]: transmissionId,
      [WEBHOOK_HEADERS.transmission_sig]: sig,
      [WEBHOOK_HEADERS.transmission_time]: time,
    };
    const raw = JSON.stringify(event);
    // Delivered after the API reply, as PayPal does; errors are swallowed (PayPal would retry).
    this.#deliveries = this.#deliveries.then(() => new Promise((r) => setTimeout(r, 0))).then(() => deliver(raw, headers)).catch(() => undefined);
  }

  #verify(body: Record<string, unknown>): Response {
    const required = ["auth_algo", "cert_url", "transmission_id", "transmission_sig", "transmission_time", "webhook_id", "webhook_event"];
    const missing = required.find((k) => body[k] === undefined || body[k] === "");
    if (missing) return ppError(400, "VALIDATION_ERROR", "MISSING_REQUIRED_PARAMETER", `${missing} is required.`);
    const tid = String(body.transmission_id);
    const sentSig = this.#transmissions.get(tid);
    const given = Buffer.from(String(body.transmission_sig));
    const expected = Buffer.from(this.#sign(tid, String(body.transmission_time), body.webhook_event));
    const ok = body.webhook_id === this.webhookId && sentSig !== undefined && given.length === expected.length && timingSafeEqual(given, expected);
    return json(200, { verification_status: ok ? "SUCCESS" : "FAILURE" });
  }
}
