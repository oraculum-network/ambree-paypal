// Typed PayPal errors. They carry what PayPal said (status, name, first issue, debug_id) and the call,
// never a header, token, credential or request body.

export type PayPalErrorKind = "http" | "auth" | "timeout" | "network" | "invalid_request" | "invalid_response";

export interface PayPalErrorInit {
  kind: PayPalErrorKind;
  status: number;
  call: string;
  code?: string;
  issue?: string;
  debugId?: string;
  message: string;
  /** Default: a network error, a timeout or a 5xx. */
  maybeDelivered?: boolean;
}

export class PayPalError extends Error {
  override name = "PayPalError";
  readonly kind: PayPalErrorKind;
  /** HTTP status, 0 when no response came back. */
  readonly status: number;
  /** PayPal's error name, e.g. UNPROCESSABLE_ENTITY, or the OAuth `error`, e.g. invalid_client. */
  readonly code: string | undefined;
  /** The first details[].issue, e.g. ORDER_NOT_APPROVED. */
  readonly issue: string | undefined;
  readonly debugId: string | undefined;
  /** "POST /v2/checkout/orders/{id}/capture": the method and path template, no ids or query. */
  readonly call: string;
  /**
   * This call, or an earlier attempt of it inside the client, may have reached PayPal and been processed:
   * it ended in a network error, a timeout or a 5xx (or a 2xx reply that couldn't be read). A definitive
   * refusal with this set doesn't prove nothing happened: an earlier attempt may have done it.
   */
  readonly maybeDelivered: boolean;
  readonly #init: PayPalErrorInit;

  constructor(init: PayPalErrorInit) {
    super(`${init.call}: ${init.message}`);
    this.#init = init;
    this.kind = init.kind;
    this.status = init.status;
    this.call = init.call;
    this.code = init.code;
    this.issue = init.issue;
    this.debugId = init.debugId;
    this.maybeDelivered = init.maybeDelivered ?? (init.kind === "network" || init.kind === "timeout" || init.status >= 500);
  }

  /** The same error, marked: an earlier attempt of this call may have reached PayPal. */
  maybeDeliveredCopy(): PayPalError {
    return this.maybeDelivered ? this : new PayPalError({ ...this.#init, maybeDelivered: true });
  }

  /** A safe one-line summary for logs and tool results. */
  summary(): string {
    const bits = [this.call, this.status ? `HTTP ${this.status}` : this.kind, this.issue ?? this.code, this.debugId ? `debug_id ${this.debugId}` : undefined];
    return bits.filter(Boolean).join(" · ");
  }
}

const MAX_TEXT = 200;

function short(s: unknown): string | undefined {
  return typeof s === "string" && s.length > 0 ? s.slice(0, MAX_TEXT) : undefined;
}

/** Builds a PayPalError from a non-2xx reply body (Orders/Payments shape or OAuth shape). */
export function errorFromBody(status: number, call: string, body: unknown): PayPalError {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const details = Array.isArray(b.details) ? (b.details as Array<Record<string, unknown>>) : [];
  const oauth = short(b.error);
  return new PayPalError({
    kind: status === 401 || oauth ? "auth" : "http",
    status,
    call,
    code: short(b.name) ?? oauth,
    issue: short(details[0]?.issue),
    debugId: short(b.debug_id),
    message: short(details[0]?.description) ?? short(b.message) ?? short(b.error_description) ?? `HTTP ${status}`,
  });
}
