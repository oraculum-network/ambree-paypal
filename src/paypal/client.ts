// PayPal REST client, sandbox only: OAuth client-credentials with a cached token, PayPal-Request-Id on
// every write, a timeout on every call, and PayPalError for every failure. Credentials live in this
// object only; they are never logged, thrown or returned.

import { randomUUID } from "node:crypto";
import type { PaymentsApi } from "./api.ts";
import { PayPalError, errorFromBody } from "./errors.ts";
import { assertSandboxBase } from "./sandbox.ts";
import type { AppOwner, Capture, CreateOrderRequest, Order, Refund, RefundRequest, WebhookEvent, WebhookTransmission } from "./types.ts";

/**
 * The identity probe (getAppOwner): an order with no payee, which PayPal pays to the app's owner and echoes.
 * Its description says what it is; nobody approves it, so no money moves and it lapses.
 */
export const IDENTITY_ORDER: CreateOrderRequest = {
  intent: "CAPTURE",
  purchase_units: [{ description: "Ambree identity check: names this REST app's owner. It is never approved and lapses.", amount: { currency_code: "EUR", value: "1.00" } }],
};
/** PayPal merchant ids seen are 13 capitals and digits; the exact rule is UNVERIFIED, so 8-20 (as config.ts). */
const MERCHANT_ID_RE = /^[A-Z0-9]{8,20}$/;

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  /** Needed only to verify webhooks. */
  webhookId?: string;
}

export interface PayPalClientOptions extends PayPalCredentials {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Called after each HTTP exchange with no ids, bodies or headers (for the spike's table and logs). */
  onCall?: (c: { call: string; status: number; ms: number }) => void;
  /**
   * How many times a write with a PayPal-Request-Id is sent again after a network error or a 5xx (default 1;
   * a GET is always retried once). The spike passes 0, so each refund POST is one exchange and the client's
   * own resend never mixes into what it asks PayPal (DESIGN.md §5 S12).
   */
  writeRetries?: number;
}

/** A refreshed token is used until this long before PayPal says it expires. */
const TOKEN_SLACK_MS = 60_000;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function checkId(id: string, what: string): string {
  if (!ID_RE.test(id)) throw new PayPalError({ kind: "invalid_request", status: 0, call: what, message: "invalid id" });
  return encodeURIComponent(id);
}

export class PayPalRestClient implements PaymentsApi {
  readonly baseUrl: string;
  readonly #creds: PayPalCredentials;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #onCall: PayPalClientOptions["onCall"];
  readonly #writeRetries: number;
  #token: { value: string; expiresAt: number } | undefined;
  #pendingToken: Promise<string> | undefined;

  constructor(opts: PayPalClientOptions) {
    this.baseUrl = assertSandboxBase(opts.baseUrl);
    if (!opts.clientId || !opts.clientSecret) {
      throw new Error("PayPal credentials missing: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
    }
    this.#creds = { clientId: opts.clientId, clientSecret: opts.clientSecret, webhookId: opts.webhookId };
    this.#fetch = opts.fetch ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#now = opts.now ?? Date.now;
    this.#onCall = opts.onCall;
    const retries = opts.writeRetries ?? 1;
    if (!Number.isInteger(retries) || retries < 0) throw new RangeError("writeRetries must be a whole number, 0 or more");
    this.#writeRetries = retries;
  }

  /** Never print the client: this keeps credentials out of util.inspect and JSON.stringify. */
  toJSON() {
    return { baseUrl: this.baseUrl };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `PayPalRestClient(${this.baseUrl})`;
  }

  createOrder(body: CreateOrderRequest, requestId: string): Promise<Order> {
    return this.#api<Order>("POST", "/v2/checkout/orders", "POST /v2/checkout/orders", body, requestId);
  }

  async getOrder(orderId: string): Promise<Order> {
    const call = "GET /v2/checkout/orders/{id}";
    return this.#api<Order>("GET", `/v2/checkout/orders/${checkId(orderId, call)}`, call);
  }

  async captureOrder(orderId: string, requestId: string): Promise<Order> {
    const call = "POST /v2/checkout/orders/{id}/capture";
    return this.#api<Order>("POST", `/v2/checkout/orders/${checkId(orderId, call)}/capture`, call, {}, requestId);
  }

  async getCapture(captureId: string): Promise<Capture> {
    const call = "GET /v2/payments/captures/{id}";
    return this.#api<Capture>("GET", `/v2/payments/captures/${checkId(captureId, call)}`, call);
  }

  async refundCapture(captureId: string, body: RefundRequest, requestId: string): Promise<Refund> {
    const call = "POST /v2/payments/captures/{id}/refund";
    return this.#api<Refund>("POST", `/v2/payments/captures/${checkId(captureId, call)}/refund`, call, body, requestId);
  }

  /** The capture id is RoutedPayments' routing hint; this client is one app and ignores it. */
  async getRefund(refundId: string, _captureId?: string): Promise<Refund> {
    const call = "GET /v2/payments/refunds/{id}";
    return this.#api<Refund>("GET", `/v2/payments/refunds/${checkId(refundId, call)}`, call);
  }

  async verifyWebhookSignature(t: WebhookTransmission, event: WebhookEvent): Promise<boolean> {
    if (!this.#creds.webhookId) throw new Error("PAYPAL_WEBHOOK_ID is not set, so webhooks cannot be verified");
    const call = "POST /v1/notifications/verify-webhook-signature";
    const reply = await this.#api<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", call, {
      auth_algo: t.auth_algo,
      cert_url: t.cert_url,
      transmission_id: t.transmission_id,
      transmission_sig: t.transmission_sig,
      transmission_time: t.transmission_time,
      webhook_id: this.#creds.webhookId,
      webhook_event: event,
    });
    return reply.verification_status === "SUCCESS";
  }

  /**
   * Who owns this app (DESIGN.md §21, D3): creates IDENTITY_ORDER (no payee) under a fresh PayPal-Request-Id
   * and reads purchase_units[0].payee.merchant_id from the reply (Prefer: return=representation). Nobody
   * approves the order; it lapses at PayPal. A missing or odd-looking merchant id is undefined, never guessed.
   */
  async getAppOwner(): Promise<AppOwner> {
    const reply = await this.#api<unknown>("POST", "/v2/checkout/orders", "POST /v2/checkout/orders", IDENTITY_ORDER, `identity-${randomUUID()}`);
    const order = (reply && typeof reply === "object" ? reply : {}) as { id?: unknown; status?: unknown; purchase_units?: unknown };
    const unit = Array.isArray(order.purchase_units) ? (order.purchase_units[0] as unknown) : undefined;
    const payee = unit && typeof unit === "object" ? ((unit as { payee?: unknown }).payee as Record<string, unknown> | undefined) : undefined;
    const payeeObj = payee && typeof payee === "object" ? payee : undefined;
    const mid = payeeObj?.merchant_id;
    const short = (v: unknown) => (typeof v === "string" ? v.slice(0, 64) : undefined);
    return {
      merchant_id: typeof mid === "string" && MERCHANT_ID_RE.test(mid) ? mid : undefined,
      order_id: short(order.id),
      order_status: short(order.status),
      payee_fields: payeeObj ? Object.keys(payeeObj).slice(0, 10) : [],
    };
  }

  /** Drops the cached token (the next call fetches a new one). */
  forgetToken(): void {
    this.#token = undefined;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#now() < this.#token.expiresAt) return this.#token.value;
    // One token request at a time, however many calls are waiting.
    this.#pendingToken ??= this.#fetchToken().finally(() => {
      this.#pendingToken = undefined;
    });
    return this.#pendingToken;
  }

  async #fetchToken(): Promise<string> {
    const call = "POST /v1/oauth2/token";
    const basic = Buffer.from(`${this.#creds.clientId}:${this.#creds.clientSecret}`).toString("base64");
    const { status, body } = await this.#send(call, `${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "grant_type=client_credentials",
    });
    if (status !== 200) throw errorFromBody(status, call, body);
    const b = body as { access_token?: unknown; expires_in?: unknown };
    if (typeof b.access_token !== "string" || typeof b.expires_in !== "number") {
      throw new PayPalError({ kind: "invalid_response", status, call, message: "token reply has no access_token or expires_in" });
    }
    this.#token = { value: b.access_token, expiresAt: this.#now() + Math.max(0, b.expires_in * 1000 - TOKEN_SLACK_MS) };
    return b.access_token;
  }

  async #api<T>(method: "GET" | "POST", path: string, call: string, body?: unknown, requestId?: string): Promise<T> {
    // A GET is retried once on a network error or 5xx. A write is retried (writeRetries times, default once)
    // only if PayPal can dedupe it (PayPal-Request-Id).
    const attempts = method === "GET" ? 2 : requestId ? 1 + this.#writeRetries : 1;
    let refreshed = false;
    // Whether an attempt so far may have reached PayPal (a network error or a 5xx): the error this call
    // ends with then says so (maybeDelivered), even if the last attempt was refused outright.
    let maybeDelivered = false;
    const fail = (e: PayPalError) => (maybeDelivered ? e.maybeDeliveredCopy() : e);
    for (let attempt = 1; ; attempt++) {
      let token: string;
      try {
        token = await this.#accessToken();
      } catch (e) {
        throw e instanceof PayPalError ? fail(e) : e;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (requestId) headers["PayPal-Request-Id"] = requestId;
      if (method === "POST" && !path.startsWith("/v1/")) headers.Prefer = "return=representation";
      let res: { status: number; body: unknown };
      try {
        res = await this.#send(call, `${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        if (!(e instanceof PayPalError)) throw e;
        if (e.maybeDelivered) maybeDelivered = true;
        if (attempt < attempts && e.kind === "network") continue;
        throw fail(e);
      }
      if (res.status >= 200 && res.status < 300) return res.body as T;
      if (res.status === 401 && !refreshed) {
        // An expired or revoked token: fetch one new token and try again, once. PayPal didn't act on it.
        refreshed = true;
        this.forgetToken();
        attempt--;
        continue;
      }
      if (res.status >= 500) maybeDelivered = true;
      if (res.status >= 500 && attempt < attempts) continue;
      throw fail(errorFromBody(res.status, call, res.body));
    }
  }

  async #send(call: string, url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    const started = this.#now();
    let res: Response;
    try {
      res = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs), redirect: "error" });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      this.#onCall?.({ call, status: 0, ms: this.#now() - started });
      throw new PayPalError({ kind: timeout ? "timeout" : "network", status: 0, call, message: timeout ? `no reply within ${this.#timeoutMs} ms` : "network error" });
    }
    const text = await res.text().catch(() => "");
    this.#onCall?.({ call, status: res.status, ms: this.#now() - started });
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // PayPal answered 2xx, so it acted on the request: this is maybe-delivered, never a refusal.
        if (res.ok) throw new PayPalError({ kind: "invalid_response", status: res.status, call, message: "reply is not JSON", maybeDelivered: true });
      }
    }
    return { status: res.status, body: parsed };
  }
}
