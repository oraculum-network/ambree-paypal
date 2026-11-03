// One PaymentsApi over several PayPal REST apps (DESIGN.md §21, D2). The spike (3 Nov) showed that PayPal
// refuses the operator's app a refund of a capture paid to another account (403 PERMISSION_DENIED), and its
// GET of such a refund, while a REST app owned by the payee's own account can do both. So the operator's app
// creates, reads and captures orders, and verifies /webhooks/paypal; each payee's own app refunds the
// captures paid to it and reads those refunds. Routing, not rewriting: the booking service calls this as it
// called the one client, and its rules (the invariants of DESIGN.md §16-§20) are unchanged.
//
// The payee apps are keyed by merchant id, so another guide is one more entry. A refund whose payee has no
// app fails closed here, before anything is sent: a definitive PayPalError (kind invalid_request, never
// maybe-delivered), which the service handles as PayPal refusing the request outright.

import type { PaymentsApi } from "./api.ts";
import { PayPalError } from "./errors.ts";
import type { AppOwner, Capture, CreateOrderRequest, Order, Refund, RefundRequest, WebhookEvent, WebhookTransmission } from "./types.ts";

/** What the router asks the booking service: who a capture paid, and which capture a recorded refund is on. */
export interface PayeeLookup {
  /** The merchant id of the account this capture paid (its booking's payee), or undefined if no paid booking has it. */
  payeeOfCapture(captureId: string): string | undefined;
  /** The capture of the booking whose refund operation recorded this refund id, or undefined. */
  captureOfRefund(refundId: string): string | undefined;
}

export interface RoutedPaymentsOptions {
  /** The operator's app (PAYPAL_CLIENT_ID): orders, captures, their GETs, and /webhooks/paypal's verification. */
  operator: PaymentsApi;
  /** Each payee's own app, by the payee's merchant id: the refund POST and the refund GET for captures paid to it. */
  payees: ReadonlyMap<string, PaymentsApi>;
  /** Read on every refund call, so it may close over a service built after the router. */
  lookup: PayeeLookup;
}

const REFUND_CALL = "POST /v2/payments/captures/{id}/refund";
const GET_REFUND_CALL = "GET /v2/payments/refunds/{id}";
/** PayPalError.code when no app may make the call. Not an issue name: ALREADY_REFUNDED_ISSUES never matches it. */
export const NO_PAYEE_APP = "PAYEE_APP_NOT_CONFIGURED";

function noApp(call: string, why: string): PayPalError {
  return new PayPalError({ kind: "invalid_request", status: 0, call, code: NO_PAYEE_APP, message: `${why}; nothing was sent`, maybeDelivered: false });
}

export class RoutedPayments implements PaymentsApi {
  readonly #operator: PaymentsApi;
  readonly #payees: ReadonlyMap<string, PaymentsApi>;
  readonly #lookup: PayeeLookup;

  constructor(opts: RoutedPaymentsOptions) {
    this.#operator = opts.operator;
    this.#payees = new Map(opts.payees);
    this.#lookup = opts.lookup;
  }

  /** The merchant ids that have their own app. */
  get payeeIds(): string[] {
    return [...this.#payees.keys()];
  }

  /** Never print a client: only the payees' merchant ids (not secrets). */
  toJSON() {
    return { payees: this.payeeIds };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `RoutedPayments(payees: ${this.payeeIds.join(", ") || "none"})`;
  }

  createOrder(body: CreateOrderRequest, requestId: string): Promise<Order> {
    return this.#operator.createOrder(body, requestId);
  }

  getOrder(orderId: string): Promise<Order> {
    return this.#operator.getOrder(orderId);
  }

  captureOrder(orderId: string, requestId: string): Promise<Order> {
    return this.#operator.captureOrder(orderId, requestId);
  }

  /** PayPal lets the order's creator read the capture (spike, 3 Nov: both apps can). */
  getCapture(captureId: string): Promise<Capture> {
    return this.#operator.getCapture(captureId);
  }

  async refundCapture(captureId: string, body: RefundRequest, requestId: string): Promise<Refund> {
    return this.#payeeApp(captureId, REFUND_CALL).refundCapture(captureId, body, requestId);
  }

  /**
   * The refund's capture is `captureId` when the caller names it (the service always does: the evidence GET
   * reads a refund no operation has recorded yet), else the capture of the operation that recorded it.
   */
  async getRefund(refundId: string, captureId?: string): Promise<Refund> {
    const capture = captureId ?? this.#lookup.captureOfRefund(refundId);
    return this.#payeeApp(capture, GET_REFUND_CALL).getRefund(refundId, capture);
  }

  verifyWebhookSignature(transmission: WebhookTransmission, event: WebhookEvent): Promise<boolean> {
    return this.#operator.verifyWebhookSignature(transmission, event);
  }

  /** The operator app's owner; each payee app's own is asked of that app directly (the startup check). */
  getAppOwner(): Promise<AppOwner> {
    return this.#operator.getAppOwner();
  }

  /** The app of the payee `captureId` paid; throws (definitive, nothing sent) when there is none. */
  #payeeApp(captureId: string | undefined, call: string): PaymentsApi {
    if (!captureId) throw noApp(call, "the refund's capture is unknown, so no payee app can be chosen");
    const payee = this.#lookup.payeeOfCapture(captureId);
    if (!payee) throw noApp(call, "no booking has this capture as paid, so its payee is unknown");
    const app = this.#payees.get(payee);
    if (!app) throw noApp(call, `no PayPal app is configured for payee merchant ${payee}, which alone may refund its capture`);
    return app;
  }
}
