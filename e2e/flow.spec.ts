import { type Page, expect, test } from "@playwright/test";

/** Request, the guide prices it, the approval card is up; returns the step-up code from the inbox. */
async function requestAndPrice(page: Page) {
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
  return { guide, link: link!, code };
}

async function requestAndPay(page: Page) {
  const { guide, link, code } = await requestAndPrice(page);
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
  return { guide, link, balance: await balance(page) };
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

// The page polls /api/state every 1.5 s. A person types the code over several polls; the card must keep
// what they typed, where they typed it, and the button must still be the one they press.
test("a code typed at human speed survives the page's refresh, and the transcript stays where the reader scrolled it", async ({ page }) => {
  const { code } = await requestAndPrice(page);
  // The card's expiry reads the same as the chat's ("expires at HH:MM UTC").
  const said = (await page.locator("#transcript").innerText()).match(/expires at (\d{2}:\d{2}) UTC/)![1]!;
  await expect(page.getByTestId("approval-card")).toContainText(`${said} UTC`);
  const input = page.getByTestId("code");
  await input.click();
  await input.pressSequentially(code.slice(0, 3), { delay: 250 });
  await page.waitForTimeout(3_400); // at least two polls in the middle of typing
  await expect(input).toHaveValue(code.slice(0, 3));
  await expect(input).toBeFocused();
  await page.keyboard.type(code.slice(3), { delay: 250 });
  await expect(input).toHaveValue(code);

  // A wrong first try: its message stays up across polls too.
  await input.fill("000000");
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("approve-msg")).not.toBeEmpty();
  await page.waitForTimeout(3_400);
  await expect(page.getByTestId("approve-msg")).not.toBeEmpty();
  await expect(input).toHaveValue("000000");

  await input.fill(code);
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("pay")).toBeVisible();

  // Reading back up the conversation: nothing new arrives, so the poll leaves the scroll alone.
  const t = page.locator("#transcript");
  await t.evaluate((e) => { e.style.maxHeight = "120px"; e.scrollTop = 0; });
  await page.waitForTimeout(3_400);
  expect(await t.evaluate((e) => e.scrollTop)).toBe(0);
});

// When the cards DO change mid-typing (here a second request arrives from another device in the same
// conversation), the rebuilt approval card keeps the typed digits and the cursor stays in the field.
test("a half-typed code survives a rebuild of the cards, with the cursor still in it", async ({ page }) => {
  const { code } = await requestAndPrice(page);
  const input = page.getByTestId("code");
  await input.click();
  await input.pressSequentially(code.slice(0, 3), { delay: 150 });
  const conv = await page.evaluate(() => sessionStorage.getItem("ambree_conv"));
  const r = await page.request.post("/api/chat", { data: { message: "Find me a hiking guide for Le Morne on Thursday and hold the spot", conversation_id: conv } });
  expect(r.ok()).toBe(true);
  await expect(page.getByTestId("booking")).toHaveCount(2); // the cards were rebuilt
  await expect(input).toHaveValue(code.slice(0, 3));
  await expect(input).toBeFocused();
  await page.keyboard.type(code.slice(3), { delay: 150 });
  await expect(input).toHaveValue(code);
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("pay")).toBeVisible();
});
