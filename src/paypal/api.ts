// The one interface the booking service pays through. Implementations: PayPalRestClient (sandbox REST, also
// used against FakePayPal's fetch in tests and the offline demo), one per PayPal app, and RoutedPayments,
// which sends refunds to the payee's own app and the rest to the operator's (DESIGN.md §21). An adapter over
// @paypal/agent-toolkit's create_order / get_order / refund tools would implement this same interface, so
// the mandate check in src/booking/ still runs before any of it (see DESIGN.md §6).

import type { AppOwner, Capture, CreateOrderRequest, Order, Refund, RefundRequest, WebhookEvent, WebhookTransmission } from "./types.ts";

export interface PaymentsApi {
  /** POST /v2/checkout/orders. `requestId` goes in PayPal-Request-Id (idempotency). */
  createOrder(body: CreateOrderRequest, requestId: string): Promise<Order>;
  /** GET /v2/checkout/orders/{id} */
  getOrder(orderId: string): Promise<Order>;
  /** POST /v2/checkout/orders/{id}/capture */
  captureOrder(orderId: string, requestId: string): Promise<Order>;
  /** GET /v2/payments/captures/{id}: its status and amount (the spike's --capture reads it; no refunded total). */
  getCapture(captureId: string): Promise<Capture>;
  /** POST /v2/payments/captures/{id}/refund. An empty body refunds in full. */
  refundCapture(captureId: string, body: RefundRequest, requestId: string): Promise<Refund>;
  /**
   * GET /v2/payments/refunds/{id}. `captureId`, the capture the refund is on, is a routing hint only (never
   * sent): PayPal lets only the capture's payee read its refunds, so RoutedPayments picks that payee's app by it.
   */
  getRefund(refundId: string, captureId?: string): Promise<Refund>;
  /** POST /v1/notifications/verify-webhook-signature → true only on verification_status SUCCESS. */
  verifyWebhookSignature(transmission: WebhookTransmission, event: WebhookEvent): Promise<boolean>;
  /** POST /v2/checkout/orders with no payee (a probe order, never approved): who owns this REST app (see AppOwner). */
  getAppOwner(): Promise<AppOwner>;
}
