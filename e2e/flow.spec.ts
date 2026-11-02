import { type Page, expect, test } from "@playwright/test";

async function requestAndPay(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByLabel("Message").fill("Find me a hiking guide for Le Morne on Thursday and hold the spot");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("#transcript li.ambree").last()).toContainText("asked them for a price for 2026-11-05");

  // The guide's phone: open the private link and price the request.
  const link = await page.getByTestId("operator-link").first().getAttribute("href");
  const guide = await page.context().newPage();
  await guide.goto(link!);
  await guide.getByLabel("Total for the group (EUR)").fill("80");
  await guide.getByLabel("Deposit to hold the spot (EUR)").fill("30");
  await guide.getByRole("button", { name: "Send price" }).click();
  await expect(guide.getByRole("status")).toContainText("Price sent");

  // The approval card, with the code from the traveller's inbox.
  await expect(page.getByTestId("approval-card")).toBeVisible();
  const msg = await page.getByTestId("inbox-msg").last().innerText();
  const code = msg.match(/\b(\d{6})\b/)![1]!;
  await expect(page.locator("#transcript")).not.toContainText(code);
  await page.getByTestId("code").fill(code);
  await page.getByTestId("approve").click();

  // The agent creates the order; the traveller pays the guide (fake checkout stands in for PayPal's).
  await page.getByTestId("pay").click();
  await expect(page.getByTestId("fake-payee")).toHaveText("LANTERNRIDGE1");
  await page.getByRole("button", { name: "Approve as the sandbox traveller" }).click();
  await expect(page.getByTestId("booking-status")).toHaveText("captured");
  await expect(page.getByTestId("paid")).toContainText("Paid EUR 30.00 to Lantern Ridge Walks (demo)");
  await expect(page.locator('#ledger li[data-kind="webhook.PAYMENT.CAPTURE.COMPLETED"]')).toHaveCount(1);
  await expect(page.locator("#chain")).toContainText("Chain OK");
  return { guide, link: link!, balance: await balance(page) };
}

/** The guide's fake balance builds up across tests (same server, same guide), so tests compare deltas. */
async function balance(page: Page): Promise<number> {
  const text = await page.getByTestId("guide-balance").innerText();
  return Number(text.match(/(\d+\.\d{2})$/)![1]);
}

test("happy path: request → guide price → mandate → PayPal → capture → ledger", async ({ page }) => {
  const { balance: after } = await requestAndPay(page);
  expect(after).toBeGreaterThanOrEqual(30);
  await expect(page.locator("#transcript li.ambree").last()).toContainText("keep an eye on the weather");
});

test("refund path: cyclone → reschedule declined → deposit refunded", async ({ page }) => {
  const { guide, link, balance: paid } = await requestAndPay(page);
  await page.getByRole("button", { name: "Simulate a cyclone warning (demo)" }).click();
  await expect(page.locator("#transcript")).toContainText("move the trip to 2026-11-08");

  await guide.goto(link);
  await expect(guide.getByRole("heading", { name: "Move the trip?" })).toBeVisible();
  await guide.getByRole("button", { name: "No, I can't" }).click();
  await expect(guide.getByRole("status")).toContainText("may get the deposit back");

  await expect(page.getByTestId("booking-status")).toHaveText("refunded");
  await expect(page.getByTestId("refunded")).toContainText("EUR 30.00");
  await expect(page.locator('#ledger li[data-kind="refund.completed"]')).toHaveCount(1);
  await expect(page.locator('#ledger li[data-kind="webhook.PAYMENT.CAPTURE.REFUNDED"]')).toHaveCount(1);
  await expect(page.locator("#chain")).toContainText("Chain OK");
  await expect(page.getByTestId("guide-balance")).toContainText((paid - 30).toFixed(2));
});
