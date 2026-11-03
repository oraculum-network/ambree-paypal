import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { PayPalRestClient } from "../src/paypal/client.ts";
import { PayPalError, errorFromBody } from "../src/paypal/errors.ts";
import { FakePayPal } from "../src/paypal/fake.ts";
import { formatMoney, fromMinor, sameMoney, toMinor } from "../src/paypal/money.ts";
import { LiveEnvironmentRefused, SANDBOX_API_BASE, assertSandboxBase } from "../src/paypal/sandbox.ts";
import { type CreateOrderRequest, type WebhookEvent, approveLink, firstCapture, transmissionFromHeaders } from "../src/paypal/types.ts";

const GUIDE = { email_address: "guide-one@business.sandbox.example" };

function setup(opts: ConstructorParameters<typeof FakePayPal>[0] = {}, timeoutMs = 2_000) {
  const fake = new FakePayPal(opts);
  const calls: string[] = [];
  const client = new PayPalRestClient({
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    webhookId: fake.webhookId,
    fetch: fake.fetch,
    timeoutMs,
    onCall: (c) => calls.push(`${c.call} ${c.status}`),
  });
  return { fake, client, calls };
}

function orderBody(value = "10.00", extra: Partial<CreateOrderRequest> = {}): CreateOrderRequest {
  return { intent: "CAPTURE", purchase_units: [{ reference_id: "bk_1", custom_id: "bk_1", amount: { currency_code: "EUR", value }, payee: GUIDE }], ...extra };
}

async function caught(p: Promise<unknown>): Promise<PayPalError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PayPalError) return e;
    throw e;
  }
  throw new Error("expected a PayPalError");
}

describe("sandbox guard", () => {
  it("accepts only the sandbox origin", () => {
    expect(assertSandboxBase(undefined)).toBe(SANDBOX_API_BASE);
    expect(assertSandboxBase("")).toBe(SANDBOX_API_BASE);
    expect(assertSandboxBase("https://api-m.sandbox.paypal.com/")).toBe(SANDBOX_API_BASE);
  });

  it.each([
    "https://api-m.paypal.com",
    "https://api.paypal.com",
    "http://api-m.sandbox.paypal.com",
    "https://api-m.sandbox.paypal.com.evil.example",
    "https://api-m.sandbox.paypal.com/v2",
    "https://user:pw@api-m.sandbox.paypal.com",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => assertSandboxBase(url)).toThrow(LiveEnvironmentRefused);
  });

  it("the client refuses live before any request", () => {
    let fetched = false;
    const f = (async () => {
      fetched = true;
      return new Response("{}");
    }) as typeof fetch;
    expect(() => new PayPalRestClient({ clientId: "a", clientSecret: "b", baseUrl: "https://api-m.paypal.com", fetch: f })).toThrow(LiveEnvironmentRefused);
    expect(fetched).toBe(false);
  });

  it("the client needs both credentials", () => {
    expect(() => new PayPalRestClient({ clientId: "", clientSecret: "b" })).toThrow(/PAYPAL_CLIENT_ID/);
  });
});

describe("OAuth", () => {
  it("fetches one token and reuses it", async () => {
    const { client, fake } = setup();
    const o = await client.createOrder(orderBody(), "r1");
    await client.getOrder(o.id);
    await client.getOrder(o.id);
    expect(fake.calls.filter((c) => c.path === "/v1/oauth2/token")).toHaveLength(1);
  });

  it("concurrent calls share one token request", async () => {
    const { client, fake } = setup();
    await Promise.all([client.createOrder(orderBody(), "a"), client.createOrder(orderBody(), "b"), client.createOrder(orderBody(), "c")]);
    expect(fake.calls.filter((c) => c.path === "/v1/oauth2/token")).toHaveLength(1);
  });

  it("refreshes once on a 401 from an expired token", async () => {
    const { client, fake } = setup();
    const o = await client.createOrder(orderBody(), "r1");
    fake.expireTokens();
    expect((await client.getOrder(o.id)).id).toBe(o.id);
    expect(fake.calls.filter((c) => c.path === "/v1/oauth2/token")).toHaveLength(2);
  });

  it("refreshes when the cached token is near expiry", async () => {
    let now = 1_000_000;
    const fake = new FakePayPal({ tokenTtlSeconds: 120 });
    const client = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch, now: () => now });
    await client.createOrder(orderBody(), "a");
    now += 61_000; // 120 s token, 60 s slack
    await client.createOrder(orderBody(), "b");
    expect(fake.calls.filter((c) => c.path === "/v1/oauth2/token")).toHaveLength(2);
  });

  it("bad credentials give an auth error that never names the secret", async () => {
    const fake = new FakePayPal();
    const secret = "s3cr3t-value-that-must-not-leak";
    const client = new PayPalRestClient({ clientId: "wrong-id", clientSecret: secret, fetch: fake.fetch });
    const e = await caught(client.createOrder(orderBody(), "r"));
    expect(e.kind).toBe("auth");
    expect(e.status).toBe(401);
    expect(e.code).toBe("invalid_client");
    const dump = `${e.message} ${e.stack} ${JSON.stringify(e)} ${inspect(e)} ${e.summary()}`;
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("wrong-id");
    expect(dump).not.toContain(Buffer.from(`wrong-id:${secret}`).toString("base64"));
  });

  it("printing the client never shows credentials", () => {
    const client = new PayPalRestClient({ clientId: "id-123", clientSecret: "secret-456" });
    const dump = `${inspect(client)} ${JSON.stringify(client)} ${String(client)}`;
    expect(dump).not.toContain("secret-456");
    expect(dump).not.toContain("id-123");
  });
});

describe("orders", () => {
  it("creates an order whose payee is the guide, with an approve link", async () => {
    const { client, fake } = setup();
    const o = await client.createOrder(orderBody("30.00"), "req-1");
    expect(o.status).toBe("CREATED");
    expect(o.purchase_units?.[0]?.payee).toEqual(GUIDE);
    expect(o.purchase_units?.[0]?.amount).toEqual({ currency_code: "EUR", value: "30.00" });
    expect(approveLink(o)).toMatch(/token=/);
    const sent = fake.calls.find((c) => c.path === "/v2/checkout/orders");
    expect(sent?.requestId).toBe("req-1");
  });

  it("with payment_source the link is payer-action", async () => {
    const { client } = setup();
    const o = await client.createOrder(orderBody("10.00", { payment_source: { paypal: { experience_context: { return_url: "https://x.example/r" } } } }), "r");
    expect(o.status).toBe("PAYER_ACTION_REQUIRED");
    expect(o.links?.find((l) => l.rel === "payer-action")).toBeDefined();
    expect(approveLink(o)).toBeDefined();
  });

  it("the same PayPal-Request-Id returns the same order", async () => {
    const { client } = setup();
    const a = await client.createOrder(orderBody(), "same");
    const b = await client.createOrder(orderBody(), "same");
    expect(b.id).toBe(a.id);
  });

  it("an invalid amount is a 400 with its issue", async () => {
    const { client } = setup();
    const e = await caught(client.createOrder(orderBody("ten"), "r"));
    expect(e.status).toBe(400);
    expect(e.issue).toBe("INVALID_PARAMETER_SYNTAX");
    expect(e.debugId).toBeTruthy();
  });

  it("an unknown payee is refused", async () => {
    const { client } = setup({ knownPayees: ["someone-else@business.sandbox.example"] });
    const e = await caught(client.createOrder(orderBody(), "r"));
    expect(e.status).toBe(422);
    expect(e.issue).toBe("PAYEE_ACCOUNT_INVALID");
  });

  it("an unknown order is a 404", async () => {
    const { client } = setup();
    const e = await caught(client.getOrder("NOPE0000000000000"));
    expect(e.status).toBe(404);
    expect(e.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("refuses an id that could change the path", async () => {
    const { client } = setup();
    await expect(client.getOrder("../oauth2/token")).rejects.toThrow(PayPalError);
  });

  it("capture needs buyer approval, then works once", async () => {
    const { client, fake } = setup();
    const o = await client.createOrder(orderBody("30.00"), "r");
    const notApproved = await caught(client.captureOrder(o.id, `capture-${o.id}`));
    expect(notApproved.issue).toBe("ORDER_NOT_APPROVED");
    fake.approve(o.id);
    expect((await client.getOrder(o.id)).status).toBe("APPROVED");
    const captured = await client.captureOrder(o.id, `capture-${o.id}-2`);
    expect(captured.status).toBe("COMPLETED");
    expect(firstCapture(captured)?.status).toBe("COMPLETED");
    expect(firstCapture(captured)?.custom_id).toBe("bk_1");
    expect(fake.balance(GUIDE)).toBe(3000);
    const again = await caught(client.captureOrder(o.id, "another-id"));
    expect(again.issue).toBe("ORDER_ALREADY_CAPTURED");
  });

  it("a replayed capture request id returns the first reply", async () => {
    const { client, fake } = setup();
    const o = await client.createOrder(orderBody(), "r");
    fake.approve(o.id);
    const a = await client.captureOrder(o.id, "cap");
    const b = await client.captureOrder(o.id, "cap");
    expect(firstCapture(b)?.id).toBe(firstCapture(a)?.id);
    expect(fake.balance(GUIDE)).toBe(1000);
  });
});

describe("refunds", () => {
  async function captured() {
    const s = setup();
    const o = await s.client.createOrder(orderBody("30.00"), "r");
    s.fake.approve(o.id);
    const c = firstCapture(await s.client.captureOrder(o.id, "c"))!;
    return { ...s, captureId: c.id };
  }

  it("partial, then the rest, then refused", async () => {
    const { client, fake, captureId } = await captured();
    const r1 = await client.refundCapture(captureId, { amount: { currency_code: "EUR", value: "10.00" }, custom_id: "bk_1" }, "rf1");
    expect(r1.status).toBe("COMPLETED");
    expect(r1.amount).toEqual({ currency_code: "EUR", value: "10.00" });
    expect((await client.getRefund(r1.id)).id).toBe(r1.id);
    const over = await caught(client.refundCapture(captureId, { amount: { currency_code: "EUR", value: "25.00" } }, "rf2"));
    expect(over.issue).toBe("REFUND_AMOUNT_EXCEEDED");
    const rest = await client.refundCapture(captureId, {}, "rf3");
    expect(rest.amount?.value).toBe("20.00");
    const done = await caught(client.refundCapture(captureId, {}, "rf4"));
    expect(done.issue).toBe("CAPTURE_FULLY_REFUNDED");
    expect(fake.balance(GUIDE)).toBe(0);
  });

  it("a currency mismatch is refused", async () => {
    const { client, captureId } = await captured();
    const e = await caught(client.refundCapture(captureId, { amount: { currency_code: "USD", value: "1.00" } }, "x"));
    expect(e.issue).toBe("REFUND_CURRENCY_MISMATCH");
  });

  it("an unknown capture is a 404", async () => {
    const { client } = setup();
    expect((await caught(client.refundCapture("C0000000000000000", {}, "x"))).status).toBe(404);
  });
});

describe("transport failures", () => {
  it("times out with kind timeout", async () => {
    const { client, fake } = setup({}, 50);
    await client.createOrder(orderBody(), "warm");
    fake.failNext({ method: "GET", path: /^\/v2\/checkout\/orders\//, status: 0, hang: true });
    fake.failNext({ method: "GET", path: /^\/v2\/checkout\/orders\//, status: 0, hang: true });
    const e = await caught(client.getOrder("ABC"));
    expect(e.kind).toBe("timeout");
    expect(e.status).toBe(0);
  });

  it("retries a write with a request id once after a network error", async () => {
    const { client, fake } = setup();
    fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 0, network: true });
    const o = await client.createOrder(orderBody(), "retry-me");
    expect(o.id).toBeTruthy();
  });

  it("retries once on a 5xx, then gives up with the PayPal error", async () => {
    const { client, fake } = setup();
    const body = { name: "INTERNAL_SERVER_ERROR", message: "An internal server error occurred.", debug_id: "dbg1", details: [] };
    fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 503, body });
    expect((await client.createOrder(orderBody(), "x")).id).toBeTruthy();
    fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 500, body });
    fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 500, body });
    const e = await caught(client.createOrder(orderBody(), "y"));
    expect(e.status).toBe(500);
    expect(e.code).toBe("INTERNAL_SERVER_ERROR");
    expect(e.debugId).toBe("dbg1");
  });

  describe("writeRetries: 0 (the spike's refund POSTs: one exchange each)", () => {
    function once(fake = new FakePayPal()) {
      const calls: string[] = [];
      const opts = { clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch, writeRetries: 0, onCall: (c: { call: string; status: number }) => void calls.push(`${c.call} ${c.status}`) };
      return { fake, calls, client: new PayPalRestClient(opts) };
    }
    const CREATE = "POST /v2/checkout/orders";

    it("doesn't resend a write after a lost reply: the error says it may have been delivered", async () => {
      const { client, fake, calls } = once();
      fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 0, dropResponse: true });
      const e = await caught(client.createOrder(orderBody(), "once-1"));
      expect([e.kind, e.maybeDelivered]).toEqual(["network", true]);
      expect(calls.filter((c) => c.startsWith(CREATE))).toEqual([`${CREATE} 0`]);
    });

    it("doesn't resend a write after a 5xx", async () => {
      const { client, fake, calls } = once();
      fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 503, body: { name: "SERVICE_UNAVAILABLE", debug_id: "d503", details: [] } });
      const e = await caught(client.createOrder(orderBody(), "once-2"));
      expect([e.status, e.maybeDelivered]).toEqual([503, true]);
      expect(calls.filter((c) => c.startsWith(CREATE))).toEqual([`${CREATE} 503`]);
    });

    it("still fetches a new token on a 401 and sends the write again (PayPal didn't act on it)", async () => {
      const { client, fake, calls } = once();
      await client.createOrder(orderBody(), "warm");
      fake.expireTokens();
      expect((await client.createOrder(orderBody(), "once-3")).id).toBeTruthy();
      expect(calls.slice(-3)).toEqual([`${CREATE} 401`, "POST /v1/oauth2/token 200", `${CREATE} 201`]);
    });

    it("still retries a GET once", async () => {
      const { client, fake } = once();
      const o = await client.createOrder(orderBody(), "once-4");
      fake.failNext({ method: "GET", path: /^\/v2\/checkout\/orders\//, status: 0, network: true });
      expect((await client.getOrder(o.id)).id).toBe(o.id);
    });

    it("must be a whole number, 0 or more", () => {
      for (const writeRetries of [-1, 0.5, Number.NaN]) {
        const opts = { clientId: "a", clientSecret: "b", writeRetries };
        expect(() => new PayPalRestClient(opts), String(writeRetries)).toThrow(RangeError);
      }
    });
  });

  it("a non-JSON 2xx reply is invalid_response", async () => {
    const f = (async (input: string | URL | Request) =>
      String(input).endsWith("/v1/oauth2/token") ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 })) : new Response("<html>", { status: 200 })) as typeof fetch;
    const client = new PayPalRestClient({ clientId: "a", clientSecret: "b", fetch: f });
    expect((await caught(client.getOrder("ABC"))).kind).toBe("invalid_response");
  });

  it("the error message never carries the bearer token", async () => {
    const { client, fake } = setup();
    fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "X", description: "nope" }] } });
    const e = await caught(client.createOrder(orderBody(), "z"));
    expect(e.message).not.toMatch(/A21AA|Bearer|Basic/);
  });
});

describe("webhook verification", () => {
  it("SUCCESS for a webhook the fake sent, FAILURE once tampered", async () => {
    const got: Array<{ raw: string; headers: Record<string, string> }> = [];
    const { client, fake } = setup({ deliver: (raw, headers) => void got.push({ raw, headers }) });
    const o = await client.createOrder(orderBody(), "r");
    fake.approve(o.id);
    await fake.flush();
    expect(got).toHaveLength(1);
    const t = transmissionFromHeaders(got[0]!.headers)!;
    const event = JSON.parse(got[0]!.raw) as WebhookEvent;
    expect(event.event_type).toBe("CHECKOUT.ORDER.APPROVED");
    expect(await client.verifyWebhookSignature(t, event)).toBe(true);
    const tampered = { ...event, resource: { ...event.resource, status: "COMPLETED" } };
    expect(await client.verifyWebhookSignature(t, tampered)).toBe(false);
    expect(await client.verifyWebhookSignature({ ...t, transmission_sig: "AAAA" }, event)).toBe(false);
  });

  it("missing transmission headers give undefined", () => {
    expect(transmissionFromHeaders({ "paypal-transmission-id": "x" })).toBeUndefined();
  });

  it("needs PAYPAL_WEBHOOK_ID", async () => {
    const fake = new FakePayPal();
    const client = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch });
    await expect(client.verifyWebhookSignature({ auth_algo: "a", cert_url: "b", transmission_id: "c", transmission_sig: "d", transmission_time: "e" }, { id: "x", event_type: "y", resource: {} })).rejects.toThrow(/PAYPAL_WEBHOOK_ID/);
  });
});

describe("money and errors", () => {
  it("converts amounts", () => {
    expect(toMinor("30")).toBe(3000);
    expect(toMinor("30.5")).toBe(3050);
    expect(toMinor("0.05")).toBe(5);
    expect(fromMinor(3050)).toBe("30.50");
    expect(sameMoney({ currency_code: "EUR", value: "30" }, { currency_code: "EUR", value: "30.00" })).toBe(true);
    expect(sameMoney({ currency_code: "EUR", value: "30" }, { currency_code: "USD", value: "30" })).toBe(false);
    expect(formatMoney({ currency_code: "EUR", value: "7.5" })).toBe("EUR 7.50");
    for (const bad of ["-1", "1.234", "1e3", "", " 1", "01"]) expect(() => toMinor(bad)).toThrow(RangeError);
  });

  it("reads the OAuth and Orders error shapes", () => {
    const a = errorFromBody(401, "POST /v1/oauth2/token", { error: "invalid_client", error_description: "Client Authentication failed" });
    expect([a.kind, a.code, a.message]).toEqual(["auth", "invalid_client", "POST /v1/oauth2/token: Client Authentication failed"]);
    const b = errorFromBody(422, "POST /x", { name: "UNPROCESSABLE_ENTITY", debug_id: "d1", details: [{ issue: "ORDER_NOT_APPROVED", description: "Payer has not approved" }] });
    expect([b.kind, b.issue, b.debugId]).toEqual(["http", "ORDER_NOT_APPROVED", "d1"]);
    expect(b.summary()).toBe("POST /x · HTTP 422 · ORDER_NOT_APPROVED · debug_id d1");
    expect(errorFromBody(502, "GET /y", undefined).message).toBe("GET /y: HTTP 502");
  });

  it("keeps every issue name from the details, first one still in `issue`", () => {
    const e = errorFromBody(422, "POST /v2/payments/captures/{id}/refund", {
      name: "UNPROCESSABLE_ENTITY",
      debug_id: "d2",
      details: [{ issue: "CAPTURE_FULLY_REFUNDED", description: "a" }, { description: "no issue here" }, { issue: 7 }, { issue: "REFUND_AMOUNT_EXCEEDED", description: "b" }],
    });
    expect(e.issue).toBe("CAPTURE_FULLY_REFUNDED");
    expect(e.issues).toEqual(["CAPTURE_FULLY_REFUNDED", "REFUND_AMOUNT_EXCEEDED"]);
    expect(e.summary()).toBe("POST /v2/payments/captures/{id}/refund · HTTP 422 · CAPTURE_FULLY_REFUNDED · debug_id d2");
    expect(errorFromBody(502, "GET /y", undefined).issues).toEqual([]);
    const many = errorFromBody(400, "POST /z", { details: Array.from({ length: 30 }, (_, i) => ({ issue: `ISSUE_${i}` })) });
    expect(many.issues).toHaveLength(10);
    expect(new PayPalError({ kind: "http", status: 422, call: "POST /q", issue: "ONE", message: "x" }).issues).toEqual(["ONE"]);
    expect(new PayPalError({ kind: "http", status: 502, call: "POST /q", issue: "ONE", message: "x" }).maybeDeliveredCopy().issues).toEqual(["ONE"]);
  });
});
