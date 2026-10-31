// /o/{token}: the guide's page. No login: the 256-bit token in the link is the capability (stored only as
// a hash). The guide sees the request and answers it: a price and deposit, a decline, a reschedule
// answer, or a refund offer. Plain HTML forms, so it works on any phone browser.

import type { Booking, BookingService } from "../booking/service.ts";
import { ServiceError } from "../booking/service.ts";
import { formatMoney } from "../paypal/money.ts";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin"><title>${esc(title)}</title><link rel="stylesheet" href="/style.css"></head>
<body class="operator"><main><p class="tag">Ambree · guide's page (sandbox demo)</p>${body}</main></body></html>`;
}

function form(token: string, action: string, label: string, fields = "", cls = ""): string {
  return `<form method="post" action="/o/${esc(token)}">${fields}<input type="hidden" name="action" value="${esc(action)}"><button type="submit" class="${cls}" data-action="${esc(action)}">${esc(label)}</button></form>`;
}

export function renderOperatorPage(token: string, b: Booking, flash?: { ok: boolean; text: string }): string {
  const parts: string[] = [];
  parts.push(`<h1>${esc(b.guide_name)}</h1>`);
  if (flash) parts.push(`<p class="flash ${flash.ok ? "ok" : "err"}" role="status">${esc(flash.text)}</p>`);
  parts.push(`<section class="card"><h2>Request</h2><dl>
<dt>Activity</dt><dd>${esc(b.activity)}</dd><dt>Where</dt><dd>${esc(b.area)}</dd><dt>Date</dt><dd data-testid="op-date">${esc(b.date)}</dd>
<dt>Party</dt><dd>${esc(b.party_size)}</dd>${b.note ? `<dt>Note</dt><dd>${esc(b.note)}</dd>` : ""}<dt>Status</dt><dd data-testid="op-status">${esc(b.status)}</dd></dl></section>`);

  if (b.status === "requested") {
    parts.push(`<section class="card"><h2>Your price</h2>
<form method="post" action="/o/${esc(token)}"><input type="hidden" name="action" value="price">
<label>Total for the group (EUR) <input name="total" inputmode="decimal" required pattern="\\d+(\\.\\d{1,2})?" placeholder="80.00"></label>
<label>Deposit to hold the spot (EUR) <input name="deposit" inputmode="decimal" required pattern="\\d+(\\.\\d{1,2})?" placeholder="30.00"></label>
<label>Note for the traveller <input name="note" maxlength="300" placeholder="Meet at the trailhead at 06:30"></label>
<button type="submit" data-action="price">Send price</button></form>
<p class="small">The deposit is paid by the traveller straight into your own PayPal account. Ambree never holds it.</p>
${form(token, "decline", "I can't do this date", "", "secondary")}</section>`);
  } else if (b.quote) {
    parts.push(`<section class="card"><h2>Your quote</h2><p>Total ${esc(formatMoney(b.quote.total))}, deposit ${esc(formatMoney(b.quote.deposit))} to ${esc(b.quote.payee.email_address ?? b.quote.payee.merchant_id)}.</p>
<p class="small mono">quote hash ${esc(b.quote_hash)}</p></section>`);
  }

  if (b.reschedule?.status === "proposed") {
    parts.push(`<section class="card warn"><h2>Move the trip?</h2><p>Ambree asks to move the trip from ${esc(b.date)} to <strong>${esc(b.reschedule.new_date)}</strong> because of the weather.</p>
${form(token, "accept_reschedule", `Yes, ${b.reschedule.new_date} works`)}${form(token, "decline_reschedule", "No, I can't", "", "secondary")}</section>`);
  }
  if ((b.status === "captured" || b.status === "partially_refunded") && !b.refund_offered) {
    parts.push(`<section class="card"><h2>Can't run it?</h2>${form(token, "offer_refund", "Offer the traveller a refund", "", "secondary")}</section>`);
  }
  return shell(`${b.guide_name}: request`, parts.join("\n"));
}

export function renderInvalidLink(): string {
  return shell("Link not valid", `<h1>This link is not valid</h1><p>Ask Ambree for a new one.</p>`);
}

/** Applies a form post from the operator page. Returns the flash message to show. */
export function applyOperatorAction(service: BookingService, token: string, form: URLSearchParams): { ok: boolean; text: string } {
  try {
    switch (form.get("action")) {
      case "price":
        service.priceQuote(token, { total: form.get("total") ?? "", deposit: form.get("deposit") ?? "", note: form.get("note") ?? "" });
        return { ok: true, text: "Price sent to the traveller." };
      case "decline":
        service.declineRequest(token);
        return { ok: true, text: "Declined. The traveller will be told." };
      case "accept_reschedule":
        service.answerReschedule(token, true);
        return { ok: true, text: "Moved. Thank you." };
      case "decline_reschedule":
        service.answerReschedule(token, false);
        return { ok: true, text: "Noted: the traveller may get the deposit back." };
      case "offer_refund":
        service.offerRefund(token);
        return { ok: true, text: "Refund offered." };
      default:
        return { ok: false, text: "Unknown action." };
    }
  } catch (e) {
    if (e instanceof ServiceError) return { ok: false, text: e.message };
    throw e;
  }
}
