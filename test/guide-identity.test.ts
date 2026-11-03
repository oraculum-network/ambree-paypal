// D3 (DESIGN.md §21): who owns a REST app, read from PayPal's own order reply. The spike (3 Nov, S11) found
// that userinfo carries no payer_id for an app token, while an order created with no payee is paid to the app
// owner, and `Prefer: return=representation` echoes that payee's merchant id (equal to the dashboard's). The
// probe order is never approved and lapses. Startup refuses unless the operator app's owner is
// PAYPAL_OPERATOR_MERCHANT_ID and no payee.

import { describe, expect, it } from "vitest";
import { identityRow } from "../scripts/spike.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { PayPalRestClient } from "../src/paypal/client.ts";
import { FakePayPal } from "../src/paypal/fake.ts";

/** A client of the fake whose requests are kept (url, method, headers, body). */
function watched(fake: FakePayPal) {
  const sent: Array<{ path: string; method: string; headers: Headers; body: unknown }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    sent.push({ path: url.pathname, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), body: typeof init?.body === "string" && url.pathname !== "/v1/oauth2/token" ? JSON.parse(init.body) : undefined });
    return fake.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { sent, client: new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch }) };
}

describe("D3: the app owner, from the payee echo of an order with no payee", () => {
  it("one POST /v2/checkout/orders: no payee, EUR 1.00, a description that says what it is, a fresh request id each time", async () => {
    const fake = new FakePayPal({ ownerMerchantId: "OWNERACCOUNT1" });
    const { sent, client } = watched(fake);
    const first = await client.getAppOwner();
    const second = await client.getAppOwner();
    expect(first).toMatchObject({ merchant_id: "OWNERACCOUNT1", order_status: "CREATED", payee_fields: ["merchant_id"] });
    expect(second.merchant_id).toBe("OWNERACCOUNT1");
    const probes = sent.filter((s) => s.path !== "/v1/oauth2/token");
    expect(probes.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /v2/checkout/orders", "POST /v2/checkout/orders"]);
    for (const p of probes) {
      expect(p.headers.get("Prefer")).toBe("return=representation");
      expect(p.body).toEqual({ intent: "CAPTURE", purchase_units: [{ description: expect.stringMatching(/identity check.*never approved/i), amount: { currency_code: "EUR", value: "1.00" } }] });
      expect((p.body as { purchase_units: Array<Record<string, unknown>> }).purchase_units[0]).not.toHaveProperty("payee");
    }
    const ids = probes.map((p) => p.headers.get("PayPal-Request-Id"));
    expect(ids[0]).toMatch(/^identity-[0-9a-f-]{36}$/);
    expect(ids[1]).not.toBe(ids[0]);
    // Never approved, never captured: it lapses at PayPal.
    expect(fake.order(first.order_id!)!.status).toBe("CREATED");
    expect(sent.some((s) => s.path.startsWith("/v1/identity/"))).toBe(false);
  });

  it("the fake: an order with no payee is paid to the calling app's owner, and userinfo is gone", async () => {
    const fake = new FakePayPal({ ownerMerchantId: "OWNERACCOUNT1" });
    const { client } = watched(fake);
    const o = await client.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "EUR", value: "5.00" } }] }, "o-nopayee");
    expect(o.purchase_units![0]!.payee).toEqual({ merchant_id: "OWNERACCOUNT1" });
    fake.approve(o.id);
    await client.captureOrder(o.id, "c-nopayee");
    expect(fake.balance({ merchant_id: "OWNERACCOUNT1" })).toBe(500);
    const res = await fake.fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${fake.clientId}:${fake.clientSecret}`).toString("base64")}` }, body: "grant_type=client_credentials" });
    const { access_token } = (await res.json()) as { access_token: string };
    expect((await fake.fetch("https://api-m.sandbox.paypal.com/v1/identity/openidconnect/userinfo?schema=openid", { headers: { Authorization: `Bearer ${access_token}` } })).status).toBe(404);
  });

  it("no merchant id in the echo: the owner is unknown (undefined), never guessed", async () => {
    const fake = new FakePayPal();
    const { client } = watched(fake);
    fake.failNext({ method: "POST", path: /^\/v2\/checkout\/orders$/, status: 201, body: { id: "PROBE0000000000X1", status: "CREATED", purchase_units: [{ payee: { email_address: "owner@business.example" } }] } });
    expect(await client.getAppOwner()).toEqual({ merchant_id: undefined, order_id: "PROBE0000000000X1", order_status: "CREATED", payee_fields: ["email_address"] });
    fake.failNext({ method: "POST", path: /^\/v2\/checkout\/orders$/, status: 201, body: { id: "PROBE0000000000X2", status: "CREATED", purchase_units: [{ payee: { merchant_id: "not a merchant id" } }] } });
    expect((await client.getAppOwner()).merchant_id).toBeUndefined();
  });
});

describe("D3: startup confirms the operator app's owner by the payee echo", () => {
  async function start(opts: { env?: Record<string, string>; owner?: string } = {}) {
    const app = createApp({ config: loadConfig({ PORT: "0", HOST: "127.0.0.1", ...opts.env }), fakeOwnerMerchantId: opts.owner });
    try {
      const port = await app.listen();
      const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as Record<string, unknown>;
      return { started: true as const, health, calls: app.fake!.calls };
    } catch (e) {
      return { started: false as const, error: String(e), calls: app.fake!.calls };
    } finally {
      await app.close().catch(() => undefined);
    }
  }

  it("the owner PayPal echoes is PAYPAL_OPERATOR_MERCHANT_ID: it starts, confirmed, after one probe order", async () => {
    const r = await start();
    expect(r).toMatchObject({ started: true, health: { operator_identity: "confirmed" } });
    expect(r.calls.filter((c) => c.method === "POST" && c.path === "/v2/checkout/orders").length).toBeGreaterThanOrEqual(1);
    expect(r.calls.some((c) => c.path.startsWith("/v1/identity/"))).toBe(false);
  });

  it("another owner: it refuses to start, naming the operator check", async () => {
    const r = await start({ owner: "SOMEONEELSE01" });
    expect(r.started).toBe(false);
    expect(r).toMatchObject({ error: expect.stringMatching(/Operator identity check failed: PayPal says the operator's REST app is owned by merchant SOMEONEELSE01, which is not PAYPAL_OPERATOR_MERCHANT_ID/) });
  });

  it("PayPal can't be asked, or echoes no merchant id: it refuses to start, naming the operator check and the opt-out", async () => {
    const app = createApp({ config: loadConfig({ PORT: "0", HOST: "127.0.0.1" }) });
    app.fake!.failNext({ method: "POST", path: /^\/v2\/checkout\/orders$/, status: 403, body: { name: "NOT_AUTHORIZED", details: [{ issue: "PERMISSION_DENIED" }] } });
    await expect(app.listen()).rejects.toThrow(/Operator identity check failed: could not ask PayPal.*HTTP 403.*PAYPAL_OPERATOR_IDENTITY=config-only/);
    app.fake!.failNext({ method: "POST", path: /^\/v2\/checkout\/orders$/, status: 201, body: { id: "PROBE0000000000X3", status: "CREATED", purchase_units: [{}] } });
    await expect(app.listen()).rejects.toThrow(/Operator identity check failed: .*echoes no payee merchant_id/);
    await app.close().catch(() => undefined);
  });

  it("config-only: no probe order, and /healthz says unconfirmed", async () => {
    const r = await start({ env: { PAYPAL_OPERATOR_IDENTITY: "config-only" }, owner: "SOMEONEELSE01" });
    expect(r).toMatchObject({ started: true, health: { operator_identity: "config-only (unconfirmed)" } });
    expect(r.calls).toEqual([]);
  });

  it("the spike's a2 row prints the payee echo, never a token", async () => {
    const fake = new FakePayPal({ ownerMerchantId: "OWNERACCOUNT1" });
    const row = await identityRow(watched(fake).client);
    expect(row).toMatchObject({ step: "a2 identity", call: "POST /v2/checkout/orders", status: "201", id: "OWNERACCOUNT1" });
    expect(row.note).toMatch(/^payee echo merchant_id OWNERACCOUNT1; probe order [A-Z0-9]+ CREATED \(never approved; it lapses\); payee fields merchant_id$/);
    expect(row.note).not.toMatch(/A21AA|Bearer/);
  });
});
