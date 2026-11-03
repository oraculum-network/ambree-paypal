// Round 10's money checks (DESIGN.md §19): what the booking holds for review, as summary() shows it, and the
// money truth: what PayPal refunded on the capture equals the booking's refunded_minor plus every amount it
// holds for review (unknown, mismatch, already refunded or unexplained).

import { expect } from "vitest";
import { toMinor } from "../../src/paypal/money.ts";
import type { Refund } from "../../src/paypal/types.ts";
import type { World } from "./race.ts";

/** The amount summary() reports held for review (`refund_review`), in minor units. */
export function heldMinor(w: World, id: string): number {
  const s = w.service.summary(w.service.get(id)!) as { refund_review: { value: string } | null };
  return s.refund_review ? toMinor(s.refund_review.value) : 0;
}

/** PayPal's completed refunds on the booking's capture == refunded_minor + what the booking holds for review. */
export function expectMoneyTruth(w: World, id: string): void {
  const b = w.service.get(id)!;
  expect({ paypal: w.fake.refundedFrom(b.capture_id!) }).toEqual({ paypal: b.refunded_minor + heldMinor(w, id) });
}

/** Every refund PayPal made, as its GET by the guide's own app (the only one PayPal lets read them) shows it now. */
export async function paypalRefunds(w: World): Promise<Refund[]> {
  return Promise.all(w.fake.refundIds().map((r) => w.guide.getRefund(r)));
}
