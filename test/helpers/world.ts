// A whole app world in memory: sqlite :memory:, the fake PayPal (webhooks delivered straight into the
// service), the demo cyclone feed and a controllable clock.

import { Channels } from "../../src/booking/channels.ts";
import { BookingService } from "../../src/booking/service.ts";
import { guidesWithPayee } from "../../src/guides/seed.ts";
import { Ledger } from "../../src/ledger/ledger.ts";
import { Mandates } from "../../src/mandate/mandate.ts";
import { PayPalRestClient } from "../../src/paypal/client.ts";
import { FakePayPal } from "../../src/paypal/fake.ts";
import type { Payee } from "../../src/paypal/types.ts";
import { openDb } from "../../src/store/db.ts";
import { DemoCycloneFeed } from "../../src/weather/cyclones.ts";

export function makeWorld(opts: { start?: string; operatorPayees?: Payee[] } = {}) {
  let t = Date.parse(opts.start ?? "2026-11-03T08:00:00Z");
  const now = () => new Date(t);
  const db = openDb();
  const fake = new FakePayPal({ checkoutUrl: "http://127.0.0.1/fake-paypal/checkout" });
  const payments = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, webhookId: fake.webhookId, fetch: fake.fetch });
  const ledger = new Ledger(db, now);
  const mandates = new Mandates(db, now);
  const channels = new Channels();
  const weather = new DemoCycloneFeed();
  const service = new BookingService({ db, ledger, mandates, payments, guides: guidesWithPayee(undefined), weather, channels, publicUrl: "http://127.0.0.1:3999", now, operatorPayees: opts.operatorPayees ?? [] });
  const webhookResults: Array<{ status: number; result: string }> = [];
  fake.deliver = async (raw, headers) => {
    webhookResults.push(await service.handleWebhook(raw, headers));
  };
  return { db, fake, payments, ledger, mandates, channels, weather, service, webhookResults, now, advance: (ms: number) => (t += ms) };
}

export function tokenOf(operatorUrl: string): string {
  return operatorUrl.split("/o/")[1]!;
}
