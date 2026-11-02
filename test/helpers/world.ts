// A whole app world in memory: sqlite :memory:, the fake PayPal (webhooks delivered straight into the
// service), the demo cyclone feed and a controllable clock. `payments` and `weather` can wrap what the
// service talks to (e.g. to hold one PayPal reply or one feed lookup while a test changes the booking).

import { Channels } from "../../src/booking/channels.ts";
import { BookingService } from "../../src/booking/service.ts";
import { guidesWithPayee } from "../../src/guides/seed.ts";
import { Ledger } from "../../src/ledger/ledger.ts";
import { Mandates } from "../../src/mandate/mandate.ts";
import type { PaymentsApi } from "../../src/paypal/api.ts";
import { PayPalRestClient } from "../../src/paypal/client.ts";
import { FakePayPal } from "../../src/paypal/fake.ts";
import type { Payee } from "../../src/paypal/types.ts";
import { openDb } from "../../src/store/db.ts";
import { type CycloneFeed, DemoCycloneFeed } from "../../src/weather/cyclones.ts";

export interface WorldOptions {
  start?: string;
  operatorPayees?: Payee[];
  /** Wraps the PayPal REST client the service pays through. */
  payments?: (inner: PaymentsApi) => PaymentsApi;
  /** Wraps the demo cyclone feed the service reads (`weather` in the result stays the demo feed). */
  weather?: (inner: DemoCycloneFeed) => CycloneFeed;
}

export function makeWorld(opts: WorldOptions = {}) {
  let t = Date.parse(opts.start ?? "2026-11-03T08:00:00Z");
  const now = () => new Date(t);
  const db = openDb();
  const fake = new FakePayPal({ checkoutUrl: "http://127.0.0.1/fake-paypal/checkout" });
  const payments = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, webhookId: fake.webhookId, fetch: fake.fetch });
  const ledger = new Ledger(db, now);
  const mandates = new Mandates(db, now);
  const channels = new Channels();
  const weather = new DemoCycloneFeed();
  const service = new BookingService({
    db,
    ledger,
    mandates,
    payments: opts.payments ? opts.payments(payments) : payments,
    guides: guidesWithPayee(undefined),
    weather: opts.weather ? opts.weather(weather) : weather,
    channels,
    publicUrl: "http://127.0.0.1:3999",
    now,
    operatorPayees: opts.operatorPayees ?? [],
  });
  const webhookResults: Array<{ status: number; result: string }> = [];
  fake.deliver = async (raw, headers) => {
    webhookResults.push(await service.handleWebhook(raw, headers));
  };
  return { db, fake, payments, ledger, mandates, channels, weather, service, webhookResults, now, advance: (ms: number) => (t += ms) };
}

export function tokenOf(operatorUrl: string): string {
  return operatorUrl.split("/o/")[1]!;
}
