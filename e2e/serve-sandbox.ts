// The sandbox-like e2e server: PayPal mode "sandbox", as hosted, with the in-process fake behind the REST
// client (AppOptions.paypalFetch), so nothing leaves the machine. The app has no stand-in checkout in this
// mode, so a tiny buyer checkout on its own port plays PayPal's: it approves the order in the fake and sends
// the browser back to /paypal/return. The fake's webhooks go to the app's /webhooks/paypal and are verified
// through the same fake. Scripted model, in-memory sqlite, fixed "today".

import { createServer } from "node:http";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_WEBHOOK_ID, FakePayPal, fakeAppFor } from "../src/paypal/fake.ts";

const PORT = 3892;
const CHECKOUT_PORT = 3893;
const APP = `http://127.0.0.1:${PORT}`;
// As hosted: the operator's app and the guide's own app (DESIGN.md §21), each a separate app in the fake,
// which refuses the operator's app a refund of the guide's capture.
const GUIDE_APP = fakeAppFor("GUIDEACCOUNT1");

const fake = new FakePayPal({ checkoutUrl: `http://127.0.0.1:${CHECKOUT_PORT}/checkout`, apps: [GUIDE_APP] });
// Each app's webhook points at its own endpoint, as the two sandbox webhooks do (DESIGN.md §21, D4).
fake.deliver = async (raw, headers, to) => {
  const path = to.clientId === FAKE_CLIENT_ID ? "/webhooks/paypal" : "/webhooks/paypal/guide";
  await fetch(`${APP}${path}`, { method: "POST", headers, body: raw, signal: AbortSignal.timeout(10_000) });
};

const checkout = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${CHECKOUT_PORT}`);
  const id = url.searchParams.get("token") ?? "";
  const order = url.pathname === "/checkout" && /^[A-Z0-9]{17}$/.test(id) ? fake.order(id) : undefined;
  if (!order) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("No such order");
    return;
  }
  if (order.status === "PAYER_ACTION_REQUIRED" || order.status === "CREATED") fake.approve(id);
  const booking = order.purchase_units?.[0]?.custom_id ?? "";
  res.writeHead(303, { Location: `${APP}/paypal/return?booking=${encodeURIComponent(booking)}&token=${id}` }).end();
});

const app = createApp({
  config: loadConfig({
    PORT: String(PORT),
    HOST: "127.0.0.1",
    PUBLIC_URL: APP,
    PAYPAL_CLIENT_ID: FAKE_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    PAYPAL_WEBHOOK_ID: FAKE_WEBHOOK_ID,
    PAYPAL_GUIDE_CLIENT_ID: GUIDE_APP.clientId,
    PAYPAL_GUIDE_CLIENT_SECRET: GUIDE_APP.clientSecret,
    PAYPAL_GUIDE_WEBHOOK_ID: GUIDE_APP.webhookId!,
    PAYPAL_GUIDE_PAYEE_MERCHANT_ID: "GUIDEACCOUNT1",
    // The fake's operator app owner, so the startup identity checks (operator and guide) really run and pass.
    PAYPAL_OPERATOR_MERCHANT_ID: "AMBREEOPER001",
  }),
  today: () => "2026-11-03",
  paypalFetch: fake.fetch,
});
await new Promise<void>((resolve) => checkout.listen(CHECKOUT_PORT, "127.0.0.1", resolve));
await app.listen();
process.on("SIGTERM", () => {
  checkout.close();
  void app.close().then(() => process.exit(0));
});
