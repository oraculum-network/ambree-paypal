import { expect, test } from "@playwright/test";

// The hosted demo's code path: PayPal mode "sandbox" (e2e/serve-sandbox.ts puts the fake behind the REST
// client and a stand-in buyer checkout on its own port). README judge step 7: Simulate is offered only
// once the newest booking is paid; the simulated warning alone refunds nothing; the guide's decline does.
test("sandbox mode: Demo controls show; pay, then simulated cyclone → reschedule declined → refund; Start over", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#mode")).toContainText("PayPal: sandbox");
  await expect(page.locator("#demo-controls")).toBeVisible();
  const simulate = page.getByRole("button", { name: "Simulate a cyclone warning (demo)" });
  const why = page.locator("#simulate-why");
  const startOver = page.getByRole("button", { name: "Start over" });
  await expect(startOver).toBeVisible();
  await startOver.click();
  await expect(simulate).toBeDisabled();
  await expect(why).toContainText("pay the deposit first");

  await page.getByLabel("Message").fill("Find me a hiking guide for Le Morne on Thursday and hold the spot");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("#transcript li.ambree").last()).toContainText("asked them for a price for 2026-11-05");
  const link = (await page.getByTestId("operator-link").first().getAttribute("href"))!;
  const guide = await page.context().newPage();
  await guide.goto(link);
  await guide.getByLabel("Total for the group (EUR)").fill("80");
  await guide.getByLabel("Deposit to hold the spot (EUR)").fill("30");
  await guide.getByRole("button", { name: "Send price" }).click();
  await expect(guide.getByRole("status")).toContainText("Price sent");

  await expect(page.getByTestId("approval-card")).toBeVisible();
  // Not paid yet: the page doesn't offer the simulation, and says why.
  await expect(simulate).toBeDisabled();
  await expect(why).toContainText("Pay for your newest booking first, then simulate");
  const code = (await page.getByTestId("inbox-msg").last().innerText()).match(/\b(\d{6})\b/)![1]!;
  await page.getByTestId("code").fill(code);
  await page.getByTestId("approve").click();
  await page.getByTestId("pay").click();
  await expect(page.getByTestId("booking-status")).toHaveText("captured");
  await expect(page.getByTestId("paid")).toContainText("Paid EUR 30.00 to Lantern Ridge Walks (demo)");
  await expect(page.locator('#ledger li[data-kind="webhook.PAYMENT.CAPTURE.COMPLETED"]')).toHaveCount(1);
  // Fake-only: the guide's balance is the fake's bookkeeping, so the page never shows it in sandbox mode.
  await expect(page.getByTestId("guide-balance")).toHaveCount(0);

  // Paid: now it can be simulated.
  await expect(simulate).toBeEnabled();
  await expect(why).toBeHidden();
  await simulate.click();
  await expect(page.locator("#demo-msg")).toContainText("Simulated cyclone warning (demo) posted for 2026-11-05");
  await expect(page.locator("#transcript")).toContainText("Simulated cyclone warning (demo) for 2026-11-05, not a real warning");
  await expect(page.locator("#transcript li.ambree").last()).toContainText("simulated cyclone warning (demo) covers the day");
  await expect(page.locator("#transcript")).toContainText("move the trip to 2026-11-08");
  await expect(page.getByTestId("simulated-warning")).toContainText("not a real warning");
  await expect(page.locator('#ledger li[data-kind="weather.simulated_alert"]')).toHaveCount(1);
  await expect(page.locator('#ledger li[data-kind^="refund."]')).toHaveCount(0);

  // The simulated warning alone unlocks no refund: asking for one now is refused and moves no money.
  await page.getByLabel("Message").fill("Please refund my deposit");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("#transcript li.ambree").last()).toContainText("doesn't allow a refund by itself");
  await expect(page.locator('#ledger li[data-kind^="refund."]')).toHaveCount(0);
  await expect(page.getByTestId("booking-status")).toHaveText("captured");

  await simulate.click();
  await expect(page.locator("#demo-msg")).toContainText("already posted");
  await expect(page.locator('#ledger li[data-kind="weather.simulated_alert"]')).toHaveCount(1);

  await guide.goto(link);
  await expect(guide.getByRole("heading", { name: "Move the trip?" })).toBeVisible();
  await guide.getByRole("button", { name: "No, I can't" }).click();
  await expect(guide.getByRole("status")).toContainText("may get the deposit back");
  await expect(page.getByTestId("booking-status")).toHaveText("refunded");
  await expect(page.getByTestId("refunded")).toContainText("EUR 30.00");
  await expect(page.locator('#ledger li[data-kind="refund.completed"]')).toHaveCount(1);
  await expect(page.locator('#ledger li[data-kind="webhook.PAYMENT.CAPTURE.REFUNDED"]')).toHaveCount(1);
  await expect(page.locator("#chain")).toContainText("Chain OK");
  // Refunded: nothing left to simulate on, and the guide's page no longer asks to move the trip.
  await expect(simulate).toBeDisabled();
  await expect(why).toContainText("already refunded");
  await guide.goto(link);
  await expect(guide.getByRole("heading", { name: "Move the trip?" })).toHaveCount(0);

  // Start over: this tab gets a new, empty conversation.
  await startOver.click();
  await expect(page.getByTestId("booking")).toHaveCount(0);
  await expect(page.locator("#transcript li")).toHaveCount(0);
  await expect(simulate).toBeDisabled();
});
