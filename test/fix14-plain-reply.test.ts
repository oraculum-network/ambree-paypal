// 5 Nov smoke on paypal.ambree.ai: the live model (nemotron-3-ultra) still wrote **bold** and numbered lists
// despite the plain-text prompt (39c97b4), and the page showed the raw asterisks. The page now shows
// Ambree's replies as plain text: emphasis markers and heading marks are dropped, everything else is kept.

import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module, no types
import { plainReply } from "../public/labels.js";

describe("fix 14: Ambree's replies show as plain text on the page", () => {
  it("drops **bold** and __bold__ markers, keeping the words", () => {
    expect(plainReply("Lantern Ridge Walks priced the hike at **EUR 80 total** (EUR 30 deposit).")).toBe(
      "Lantern Ridge Walks priced the hike at EUR 80 total (EUR 30 deposit).",
    );
    expect(plainReply("held for __Thursday, 2026-11-05__ for 2 people")).toBe("held for Thursday, 2026-11-05 for 2 people");
  });

  it("drops a heading's leading # marks, keeping numbered lines and dashes as written", () => {
    const reply = "## Two guides\n1. **Lantern Ridge Walks** – sunrise climbs\n2. **Quillfeather Trails** – slow hikes";
    expect(plainReply(reply)).toBe("Two guides\n1. Lantern Ridge Walks – sunrise climbs\n2. Quillfeather Trails – slow hikes");
  });

  it("leaves text with no markers unchanged, including single asterisks, ids and amounts", () => {
    for (const s of [
      "Paid: EUR 30.00 went to Lantern Ridge Walks (demo)'s PayPal (capture 8C7666326U616725N).",
      "2 * 15 = 30, and a lone ** stays",
      "refund ID: 4C334698L96883928",
      "",
    ]) {
      expect(plainReply(s)).toBe(s);
    }
  });

  it("never returns markup: the result is text for textContent", () => {
    expect(plainReply("**<b>x</b>**")).toBe("<b>x</b>");
  });
});
