// A whole app world in memory: sqlite :memory:, the fake PayPal (webhooks delivered straight into the
// service), the demo cyclone feed and a controllable clock. `payments` and `weather` can wrap what the
// service talks to (e.g. to hold one PayPal reply or one feed lookup while a test changes the booking).
// The service pays through RoutedPayments (DESIGN.md §21): the operator's app for orders and captures, and
// each guide payee's own app for its refunds.

import { Channels } from "../../src/booking/channels.ts";
import { BookingService } from "../../src/booking/service.ts";
import { guidesWithPayee } from "../../src/guides/seed.ts";
import { Ledger } from "../../src/ledger/ledger.ts";
import { Mandates } from "../../src/mandate/mandate.ts";
import type { PaymentsApi } from "../../src/paypal/api.ts";
import { PayPalRestClient } from "../../src/paypal/client.ts";
import { type FakeApp, FakePayPal, fakeAppFor } from "../../src/paypal/fake.ts";
import { RoutedPayments } from "../../src/paypal/routed.ts";
import type { Payee } from "../../src/paypal/types.ts";
import { openDb } from "../../src/store/db.ts";
import { type CycloneFeed, DemoCycloneFeed } from "../../src/weather/cyclones.ts";

export interface WorldOptions {
  start?: string;
  operatorPayees?: Payee[];
  /** Wraps what the service pays through (the router over the apps). */
  payments?: (inner: PaymentsApi) => PaymentsApi;
  /** Wraps each app's client inside the router: `name` is "operator" or the payee's merchant id. */
  apps?: (name: string, inner: PaymentsApi) => PaymentsApi;
  /** The guide payees (merchant ids) that have their own app. Default: every seed guide's. Left out: its refunds fail closed. */
  payeeApps?: string[];
  /** Wraps the demo cyclone feed the service reads (`weather` in the result stays the demo feed). */
  weather?: (inner: DemoCycloneFeed) => CycloneFeed;
}

export function makeWorld(opts: WorldOptions = {}) {
  let t = Date.parse(opts.start ?? "2026-11-03T08:00:00Z");
  const now = () => new Date(t);
  const db = openDb();
  const fake = new FakePayPal({ checkoutUrl: "http://127.0.0.1/fake-paypal/checkout" });
  const guides = guidesWithPayee(undefined);
  const wrap = (name: string, c: PaymentsApi) => (opts.apps ? opts.apps(name, c) : c);
  const operator = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, webhookId: fake.webhookId, fetch: fake.fetch });
  const payeeIds = opts.payeeApps ?? [...new Set(guides.map((g) => g.payee.merchant_id))];
  /** Each guide payee's own app, registered with the fake (which refuses the operator's app its refunds). */
  const guideApps = new Map(
    payeeIds.map((m) => {
      const a = fakeAppFor(m);
      const registered = fake.addApp(a);
      return [m, new PayPalRestClient({ clientId: a.clientId, clientSecret: a.clientSecret, webhookId: registered.webhookId, fetch: fake.fetch })];
    }),
  );
  let service!: BookingService;
  const payments = new RoutedPayments({
    operator: wrap("operator", operator),
    payees: new Map([...guideApps].map(([m, c]) => [m, wrap(m, c)])),
    lookup: { payeeOfCapture: (c) => service.payeeOfCapture(c), captureOfRefund: (r) => service.captureOfRefund(r) },
  });
  const ledger = new Ledger(db, now);
  const mandates = new Mandates(db, now);
  const channels = new Channels();
  const weather = new DemoCycloneFeed();
  service = new BookingService({
    db,
    ledger,
    mandates,
    payments: opts.payments ? opts.payments(payments) : payments,
    guides,
    weather: opts.weather ? opts.weather(weather) : weather,
    channels,
    publicUrl: "http://127.0.0.1:3999",
    now,
    operatorPayees: opts.operatorPayees ?? [],
  });
  const webhookResults: Array<{ status: number; result: string }> = [];
  /**
   * A webhook as the app's endpoint takes it (DESIGN.md §21, D4): one on the operator's app's webhook (or
   * `to` absent) as /webhooks/paypal, verified through the service's PaymentsApi (the operator's app); one on
   * a guide app's webhook as /webhooks/paypal/guide, verified through the payee apps.
   */
  const webhook = (d: { raw: string; headers: Record<string, string>; to?: FakeApp }) =>
    !d.to || d.to.clientId === fake.clientId ? service.handleWebhook(d.raw, d.headers) : service.handleWebhook(d.raw, d.headers, payments.payeeWebhooks);
  fake.deliver = async (raw, headers, to) => {
    webhookResults.push(await webhook({ raw, headers, to }));
  };
  /** The first seed guide's own app (g_lantern's, the guide the tests book), for acts outside the service. */
  const lantern = fakeAppFor(guides[0]!.payee.merchant_id);
  const guide = guideApps.get(lantern.ownerMerchantId) ?? new PayPalRestClient({ clientId: lantern.clientId, clientSecret: lantern.clientSecret, fetch: fake.fetch });
  return { db, fake, payments, operator, guideApps, guide, ledger, mandates, channels, weather, service, webhook, webhookResults, now, advance: (ms: number) => (t += ms) };
}

export function tokenOf(operatorUrl: string): string {
  return operatorUrl.split("/o/")[1]!;
}
