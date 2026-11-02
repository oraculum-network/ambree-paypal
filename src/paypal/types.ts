// The slice of PayPal's Orders v2, Payments v2 and Webhooks v1 JSON that this app reads and writes.
// Field names are PayPal's. Shapes marked UNVERIFIED in DESIGN.md §4 are checked by scripts/spike.ts.

export type CurrencyCode = "EUR" | "USD";

export interface Money {
  currency_code: CurrencyCode;
  /** A decimal string, as PayPal sends it: "30.00". */
  value: string;
}

/** Who receives the funds. Exactly one of the two. */
export type Payee = { email_address: string; merchant_id?: never } | { merchant_id: string; email_address?: never };

export interface Link {
  href: string;
  rel: string;
  method?: string;
}

export interface PurchaseUnitRequest {
  reference_id?: string;
  custom_id?: string;
  invoice_id?: string;
  description?: string;
  amount: Money;
  payee?: Payee;
}

export interface ExperienceContext {
  return_url?: string;
  cancel_url?: string;
  brand_name?: string;
  user_action?: "PAY_NOW" | "CONTINUE";
  shipping_preference?: "NO_SHIPPING" | "GET_FROM_FILE" | "SET_PROVIDED_ADDRESS";
}

export interface CreateOrderRequest {
  intent: "CAPTURE";
  purchase_units: PurchaseUnitRequest[];
  payment_source?: { paypal: { experience_context?: ExperienceContext } };
}

export type OrderStatus = "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
export type CaptureStatus = "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED";
export type RefundStatus = "CANCELLED" | "FAILED" | "PENDING" | "COMPLETED";

export interface Capture {
  id: string;
  status: CaptureStatus;
  amount: Money;
  final_capture?: boolean;
  custom_id?: string;
  invoice_id?: string;
  create_time?: string;
  links?: Link[];
}

export interface Order {
  id: string;
  intent?: string;
  status: OrderStatus;
  purchase_units?: Array<PurchaseUnitRequest & { payments?: { captures?: Capture[] } }>;
  payer?: { email_address?: string; payer_id?: string; name?: { given_name?: string; surname?: string } };
  create_time?: string;
  update_time?: string;
  links?: Link[];
}

export interface RefundRequest {
  /** Omit for a full refund. */
  amount?: Money;
  custom_id?: string;
  invoice_id?: string;
  note_to_payer?: string;
}

export interface Refund {
  id: string;
  status: RefundStatus;
  amount?: Money;
  custom_id?: string;
  note_to_payer?: string;
  /**
   * UNVERIFIED (DESIGN.md §19): `total_refunded_amount` is taken to be PayPal's running total refunded on the
   * capture (completed refunds), carried on the refund reply and on GET. Absent: the check that uses it is
   * skipped.
   */
  seller_payable_breakdown?: { gross_amount?: Money; net_amount?: Money; total_refunded_amount?: Money };
  create_time?: string;
  /** `up` names the capture (`/v2/payments/captures/{id}`); UNVERIFIED on webhook resources (§19). */
  links?: Link[];
}

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource_version?: string;
  event_version?: string;
  create_time?: string;
  summary?: string;
  resource: Record<string, unknown>;
  links?: Link[];
}

/**
 * Who PayPal says owns the REST app, from GET /v1/identity/openidconnect/userinfo with the app's own token.
 * UNVERIFIED (spike S11): that this call accepts a client-credentials token and describes the app owner,
 * and that `payer_id` is the owner's merchant id. The docs' sample shows user_id/sub but no payer_id.
 */
export interface OperatorIdentity {
  /** `payer_id` from the reply, when it looks like a merchant id; undefined otherwise. */
  merchant_id?: string;
  /** The reply's top-level field names (for the spike's report; no values). */
  fields: string[];
  user_id?: string;
  account_type?: string;
}

/** The 5 PAYPAL-* transmission headers, lower-cased as Node gives them. */
export interface WebhookTransmission {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
}

export const WEBHOOK_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const satisfies Record<keyof WebhookTransmission, string>;

/** Reads the transmission headers; undefined if any is missing. */
export function transmissionFromHeaders(headers: Record<string, string | string[] | undefined>): WebhookTransmission | undefined {
  const out: Partial<WebhookTransmission> = {};
  for (const [key, header] of Object.entries(WEBHOOK_HEADERS) as Array<[keyof WebhookTransmission, string]>) {
    const v = headers[header];
    const s = Array.isArray(v) ? v[0] : v;
    if (!s) return undefined;
    out[key] = s;
  }
  return out as WebhookTransmission;
}

/** The buyer-approval link: `approve` for a plain order, `payer-action` with payment_source (S5 in DESIGN.md). */
export function approveLink(order: Pick<Order, "links">): string | undefined {
  return order.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href;
}

export function firstCapture(order: Order): Capture | undefined {
  return order.purchase_units?.[0]?.payments?.captures?.[0];
}
