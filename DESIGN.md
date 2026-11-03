# Ambree "Book the guide": design

Ambree (an AI travel concierge) books a small independent guide in Mauritius and has the traveller pay the guide's
deposit **straight into the guide's own PayPal account**. The agent can find, ask, quote and prepare. It can only
create a payment order inside a **mandate** that the traveller approved with a step-up code. Every step is written
to a hash-chained ledger. Money flows from the traveller to the guide. **Ambree never holds or receives it.**

Status: design for the PayPal AI Hackathon build (submissions close Thu 12 Nov 2026, 12:00 PT). **Sandbox only.**
Anything I could not check in PayPal's docs is marked **UNVERIFIED**. The Monday spike (`scripts/spike.ts`) checks
the risky items.

## 1. Actors and parts

| Actor / part | What it is |
|---|---|
| Traveller | Chats with Ambree on the web page (`/`), approves the mandate, then pays in PayPal checkout (sandbox personal account) |
| Guide | A made-up independent guide (seed data). Sees the request on a tokenised operator page `/o/{token}`, sets a price, accepts or declines a reschedule. Has a sandbox **business** account that is the order's `payee` |
| Agent | The tool loop (`src/agent/`): an OpenAI-compatible chat model (`LLM_*` env) or the scripted model (offline, deterministic). It sees tool results only. It never sees step-up codes or PayPal credentials |
| Booking service | `src/booking/`: the rules. The mandate check, payee pinning, refund policy and ledger writes live here, not in the prompt |
| PayPal tier | `src/paypal/`: the `PaymentsApi` interface, the REST client (sandbox only) and an in-process fake that speaks the same JSON |
| Ledger | `src/ledger/`: an append-only table in `node:sqlite`, where each row's `hash` = sha256 of the row + `prev_hash` |
| Weather | `src/weather/`: the cyclone feed interface. GDACS later (**UNVERIFIED** API shape); a demo feed for tests and the offline demo, and per-booking simulated warnings on the hosted sandbox (§14) |
| MCP | `POST /mcp`: the same tools for any MCP client (stateless Streamable HTTP, as in ambree-qloo) |

## 2. Flows

### 2.1 Request → quote → mandate → order → approval → capture → webhook → ledger

```
Traveller        Agent (tools)          Booking service          Guide (/o/{token})      PayPal (sandbox)
   | "hiking guide, Le Morne, Thursday, hold the spot"
   |----------------->|
   |                  | search_guides(area, activity, date)
   |                  | request_quote(guide_id, date, party)
   |                  |---------------------->| booking=requested; operator token minted
   |                  |                       | ledger: quote.requested
   |                  |                       |----- link /o/{token} ---->| (demo: "guide's phone" panel)
   |                  |                       |                           | sees request, sets price + deposit
   |                  |                       |<------ POST /o/{token} ---|
   |                  |                       | quote frozen; quote_hash = sha256(canonical(quote))
   |                  |                       | ledger: quote.priced
   |  (event: "guide priced") --------------->|
   |                  | propose_mandate(booking_id)
   |                  |---------------------->| mandate{amount, payee, quote_hash, expires_at, nonce}
   |                  |                       | step-up code sent to the traveller only (demo inbox),
   |                  |                       | stored as a hash; ledger: mandate.proposed
   | approval card: amount, payee, expiry, code
   |-- POST /api/mandates/{id}/approve {code} ------------------------>| check code, expiry, attempts
   |                  |                       | ledger: mandate.approved
   |  (event: "mandate approved") ----------->|
   |                  | create_order(booking_id)
   |                  |---------------------->| re-check: approved, not expired, nonce unused,
   |                  |                       | hash(current quote) == mandate.quote_hash,
   |                  |                       | amount == mandate.amount, payee == mandate.payee
   |                  |                       | nonce marked used, then:
   |                  |                       |-- POST /v2/checkout/orders (PayPal-Request-Id = nonce) -->|
   |                  |                       |<----------------------- 201 {id, status: CREATED, links} --|
   |                  |                       | ledger: order.created
   | "Pay the guide" button = approve link
   |---------------------------------------------- PayPal checkout (buyer logs in, approves) ------->|
   |<-------------------------------------- redirect return_url ?token={order id} -------------------|
   |-- GET /paypal/return -------------------->| capture_if_approved:
   |                  |                       |-- POST /v2/checkout/orders/{id}/capture -------------->|
   |                  |                       |<------------------------- 201 {status: COMPLETED} -----|
   |                  |                       | ledger: capture.completed (the API reply)
   |                  |                       |<-- webhook CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED
   |                  |                       |-- POST /v1/notifications/verify-webhook-signature --->|
   |                  |                       | SUCCESS → ledger: webhook.<event_type> (once per event id; redelivered until processed)
```

Capture can be triggered three ways: the return URL, the `CHECKOUT.ORDER.APPROVED` webhook, or the agent's
`capture_order` tool. All three go through one idempotent `captureIfApproved` (PayPal-Request-Id
`capture-{order_id}`). The booking counts as **paid** only once the capture reply says `COMPLETED`. A verified
`PAYMENT.CAPTURE.COMPLETED` webhook is logged as confirmation.

### 2.2 Cyclone → reschedule or refund

```
Weather feed      Agent                      Booking service                 Guide             PayPal
  | alert(TC, level, window) for the booking date
  |  (event: "cyclone warning") ->|
  |                               | check_weather(booking_id)  -> alert + plain risk explanation
  |                               | propose_reschedule(booking_id, new_date)
  |                               |-------------------------->| ledger: reschedule.proposed
  |                               |                           |-- /o/{token} shows the new date -->|
  |                               |                           |<- accept | decline ---------------|
  |                               |                           | accept: booking.date = new_date; ledger: reschedule.accepted
  |                               |                           | decline: refund now allowed;      ledger: reschedule.declined
  |                               | refund_payment(booking_id, amount?)   (only if policy allows)
  |                               |-------------------------->|-- POST /v2/payments/captures/{id}/refund -->|
  |                               |                           |<------------------- 201 {id, status} -------|
  |                               |                           | ledger: refund.completed; later webhook PAYMENT.CAPTURE.REFUNDED
```

**Refund policy** (`BookingService.refundReason` in `src/booking/service.ts`). A refund is allowed when the booking is captured and one of these holds:
(a) a real feed alert (orange or red) covers the booking date, (b) the guide declined a reschedule, or (c) the
guide offered the refund on the operator page. The hosted demo's simulated warning (§14) is not a feed alert and
never allows a refund by itself: it only gets the agent to propose a reschedule, and (b) or (c) decides. The amount must be at most the captured amount minus earlier refunds.
Partial refunds are allowed. The agent cannot refund for any other reason; it can only explain.

## 3. Data model (`node:sqlite`, one file, or `:memory:` in tests)

```
guides(id, name, area, activities[], languages[], bio, payee{email_address|merchant_id}, currency)      -- seed, in code
bookings(id, conversation_id, guide_id, activity, area, date, party_size, status,
         operator_token_hash, quote?, quote_hash?, mandate_id?, order_id?, approve_url?, capture_id?,
         captured{currency_code,value}?, refunded_minor, refund_ids[], reschedule?{new_date,status,n?}, refund_offered,
         refund_ops[{n, request_id, amount_minor, full, reason,
                     status: sending|pending|completed|failed|needs_review, refund_id?,
                     maybe_sent?, review_cause?: unknown|mismatch|already_refunded|unexplained,
                     acknowledged?, evidence?}],                                                       -- §18, §19
         paypal_refunded_minor?,                                                                         -- §19
         created_at, updated_at)                                                                         -- records table, JSON
mandates(id, booking_id, amount{currency_code,value}, payee, quote_hash, nonce, expires_at,
         step_up_hash, attempts, status: proposed|approved|used|expired|locked)                          -- records table, JSON
ledger(seq INTEGER PRIMARY KEY, at, booking_id, kind, data JSON, prev_hash, hash)                        -- append-only
webhook_events(event_id PRIMARY KEY, event_type, received_at)                                            -- dedupe
```

- **Booking status:** `requested → priced → mandate_proposed → mandate_approved → order_created → (capture_pending →) captured → (refunded | partially_refunded)`.
  A definitive create failure goes back to `priced`. `needs_review` (the order or capture doesn't match
  the mandate, a capture PayPal already reports refunded before it was recorded as paid, or a refund held
  for review) and `capture_failed` stop the money steps. Only a refund held because its outcome was unknown
  ever leaves review, when its own webhook settles it (§18). A refund PayPal reports that no refund of the
  booking accounts for, or a PayPal total above what it accounts for, holds it for good (§19).
  `declined` (the guide said no) and `cancelled` are terminal. A reschedule keeps the status and changes `date`.
- **Reschedule:** `proposed → accepted | declined`, or `withdrawn` when a refund (part or all of the deposit,
  §15, §16) completes before the guide answered. It can be proposed and answered only while the booking is
  `captured` and no refund has started. Each proposal is numbered (`n`, since round 8; absent on older
  records, which count as 0), and the guide's answer names the proposal it answers (§17).
- **Quote** (frozen once priced): `{booking_id, guide_id, guide_name, activity, area, date, party_size,
  total{currency_code,value}, deposit{currency_code,value}, payee, guide_note, priced_at}`. The **quote hash** is
  sha256 hex of the canonical JSON: keys sorted, no whitespace, strings NFC.
- **Mandate:**
  - It expires 15 minutes after it is proposed.
  - The nonce is 128 random bits (hex) and is used once; it is also the create-order `PayPal-Request-Id`.
  - The step-up code is 6 digits; only sha256(mandate_id + code) is stored.
  - After 5 wrong codes the mandate is `locked`.
  - The code goes to the traveller's channel only. In the demo that is a "demo inbox" panel; the real channel
    would be email or SMS. It is never in a tool result.
- **Ledger:**
  - `hash = sha256(canonical({seq, at, booking_id, kind, data, prev_hash}))`; the first row's `prev_hash` is 64 zeros.
  - `verify()` walks every row and reports the first bad `seq`.
  - Rows are never updated or deleted, and the code has no API that could do so.
  - A tamper test edits the SQLite row directly and expects `verify()` to fail at that row.
- **Amounts:** strings on the wire (PayPal's `value`). Comparisons go through integer minor units (EUR and USD
  have 2 decimals).

## 4. PayPal REST calls (all against `https://api-m.sandbox.paypal.com`)

The base URL is a constant. `src/paypal/sandbox.ts` refuses any other origin; this guard is what refuses
`api-m.paypal.com`. Startup fails if `PAYPAL_BASE_URL` is set to anything else. Credentials are read by name only:
`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`.

| # | Call | Method + path | Body / headers we send | Doc read (31 Oct) |
|---|---|---|---|---|
| 1 | OAuth token | `POST /v1/oauth2/token` | `Authorization: Basic base64(client_id:client_secret)`, `Content-Type: application/x-www-form-urlencoded`, body `grant_type=client_credentials`. Reply: `access_token`, `token_type` (Bearer), `expires_in` (s), `app_id`, `scope`, `nonce`. Cached until 60 s before `expires_in` runs out | https://developer.paypal.com/api/rest/authentication/ |
| 2 | Create order | `POST /v2/checkout/orders` | Headers: `Authorization: Bearer …`, `PayPal-Request-Id` (idempotency), `Prefer: return=representation`. Body: `{"intent":"CAPTURE","purchase_units":[{"reference_id":booking_id,"custom_id":booking_id,"invoice_id":"AMB-"+booking_id,"description":"Guide deposit: …","amount":{"currency_code":"EUR","value":"30.00"},"payee":{"email_address":…}|{"merchant_id":…}}],"payment_source":{"paypal":{"experience_context":{"return_url":…,"cancel_url":…,"user_action":"PAY_NOW","shipping_preference":"NO_SHIPPING","brand_name":"Ambree"}}}}` | https://developer.paypal.com/docs/api/orders/v2/orders-create (`intent`, `purchase_units[]` 1-10, `reference_id`, `description` ≤127, `custom_id`, `invoice_id` unique per merchant, `amount`, `payee{email_address,merchant_id}`, `PayPal-Request-Id`, `Prefer`). The `experience_context` fields were cut off in my fetch: **UNVERIFIED** |
| 3 | Show order | `GET /v2/checkout/orders/{id}` | none. Reply: `status`, `links[]`, `payer{name, email_address, payer_id}` | https://developer.paypal.com/docs/api/orders/v2/orders-get (example has `status: APPROVED`, links `self`, `approve`, `edit`, `capture`). The full status enum (`CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED`) is **UNVERIFIED** (from memory) |
| 4 | Capture | `POST /v2/checkout/orders/{id}/capture` | `PayPal-Request-Id: capture-{id}`, `Prefer: return=representation`, `Content-Type: application/json`, body `{}`. Reply: `purchase_units[0].payments.captures[0].{id,status,amount}`: **UNVERIFIED** shape (from memory; the get page had no captures) | https://developer.paypal.com/docs/api/orders/v2/ (path) |
| 5 | Refund | `POST /v2/payments/captures/{capture_id}/refund` | `PayPal-Request-Id: refund-{booking}-{n}`, `Prefer: return=representation`. Body: `{}` (full) or `{"amount":{"currency_code":"EUR","value":"10.00"},"note_to_payer":…,"custom_id":booking_id}`. Reply: `id`, `status` | https://developer.paypal.com/docs/api/payments/v2/captures-refund ("omit amount for a full refund"; `PayPal-Auth-Assertion` "establishing the consent to act-on-behalf of a merchant is a prerequisite"). The status enum beyond `COMPLETED` is **UNVERIFIED** |
| 6 | Show refund | `GET /v2/payments/refunds/{refund_id}` | none | https://developer.paypal.com/docs/api/payments/v2/ |
| 7 | Verify webhook | `POST /v1/notifications/verify-webhook-signature` | `{"auth_algo": h[PAYPAL-AUTH-ALGO], "cert_url": h[PAYPAL-CERT-URL], "transmission_id": h[PAYPAL-TRANSMISSION-ID], "transmission_sig": h[PAYPAL-TRANSMISSION-SIG], "transmission_time": h[PAYPAL-TRANSMISSION-TIME], "webhook_id": env PAYPAL_WEBHOOK_ID, "webhook_event": <parsed body>}`. All are required. Reply `verification_status` (`SUCCESS` in the example; `FAILURE` as the other value is **UNVERIFIED**) | https://developer.paypal.com/docs/api/webhooks/v1/verify-webhook-signature-post |
| 8 | Create webhook (setup, once) | `POST /v1/notifications/webhooks` | URL `https://paypal.ambree.ai/webhooks/paypal`, events below. Done in the dashboard by the CEO, or later by script | https://developer.paypal.com/docs/api/webhooks/v1/ |
| 9 | Simulate event (optional) | `POST /v1/notifications/simulate-event` | for testing the endpoint once deployed | same |

**Payee:** "Include the email_address or merchant_id of the account to receive the payment… Add the payee object to
the transaction payload". Without it, the funds go to the app owner (https://developer.paypal.com/docs/checkout/standard/customize/pay-another-account/).
That page does not say what the receiving account needs, or whether the API caller may capture or refund such an
order: **UNVERIFIED, spike items S2 and S4.**

**Webhook events we subscribe to** (https://developer.paypal.com/api/rest/webhooks/event-names/):
`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.PENDING`,
`PAYMENT.CAPTURE.DECLINED` (the page lists v2 as `DECLINED` and v1 as `DENIED`; we accept both), and `PAYMENT.CAPTURE.REVERSED`.
The resource each event carries is not on that page. We assume order, capture and refund objects with
`custom_id`: **UNVERIFIED**. The handler finds the booking by `resource.custom_id`, falling back to the order,
capture or refund id it already stored.

**Errors.** The PayPal error body is `{name, message, debug_id, details[{issue, description}]}`. This is from memory:
**UNVERIFIED**. It becomes `PayPalError{status, name, issue, debugId, message}`, which never carries headers,
tokens or credentials. Issue names we handle (all **UNVERIFIED**): `ORDER_NOT_APPROVED`, `ORDER_ALREADY_CAPTURED`,
`CAPTURE_FULLY_REFUNDED`, `REFUND_AMOUNT_EXCEEDED`, `PAYEE_ACCOUNT_RESTRICTED`, `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`.
The OAuth error body is `{error, error_description}`. Timeouts: 15 s per call (`AbortSignal.timeout`). One retry,
only on network errors or 5xx: for a GET always, for a write only if it carries a `PayPal-Request-Id`. The
client's `writeRetries` (default 1) sets the writes' count; the spike passes 0 (§5 S12).

## 5. Unknown until the spike (Mon 2 Nov)

| Id | Question | How the spike answers it |
|---|---|---|
| S1 | Does a sandbox REST app's token work for orders with a **third-party payee** (`email_address` of another sandbox business account)? | (b) the create reply's status and payee echo |
| S2 | Can the API caller (the app owner, not the payee) **capture** that order? | (d) |
| S3 | Does `merchant_id` work as well as `email_address`? | run with `--payee-merchant-id` |
| S4 | Can the API caller **refund** a capture whose payee is another account, without `PayPal-Auth-Assertion`? | (e1), and (e4) for the rest. If not, the fallbacks are (i) the guide refunds from their own PayPal (the operator page then says how) or (ii) the report's fallback, an invoice from the guide's own app |
| S5 | Which approve link comes back with `payment_source.paypal.experience_context`: `approve` or `payer-action`? | the printed links |
| S6 | The capture reply shape, and whether `custom_id` is echoed on the capture | the printed ids |
| S7 | The exact webhook payloads and headers; `verification_status` values | after deploy: a sandbox webhook to `paypal.ambree.ai`, plus `simulate-event` |
| S8 | Does a personal sandbox account work as payee (concept A's question)? Not needed for B | optional run |
| S9 | Currency: EUR versus USD for an MU business sandbox account | run once with each |
| S10 | JS SDK v6 buttons versus the redirect approve link for a third-party payee | not in the spike; the build uses the approve link (redirect) first |
| S11 | (The refund premises at the end of §19 and §20 are S12.) Does `GET /v1/identity/openidconnect/userinfo?schema=openid`, called with the **app's client-credentials token**, describe the REST app's owner, and is its `payer_id` the owner's merchant id (equal to the id in the sandbox dashboard)? If not, which documented call returns the app owner's merchant id? | row "a2 identity": prints payer_id, user_id, account_type and the field names (never a token). Compare payer_id with the dashboard's merchant id |
| S12 | The **refund premises** the code now depends on (§19 "Verify in spike S11", and §20), numbered in that list's order: **P1** dedupe of a repeated `PayPal-Request-Id`; **P2** `custom_id` on the refund; **P2b** its `links[rel=up]` to the capture; **P3** the resource of `PAYMENT.CAPTURE.REFUNDED` and of `PAYMENT.CAPTURE.REVERSED` (§20); **P4** the refund failure event names; **P5** `seller_payable_breakdown.total_refunded_amount`; **P6** a refund PENDING then FAILED or CANCELLED; **P7** the issue a refused refund carries | (e1)-(e6) on the captured amount A, which must be at least 2.00: e1 refunds 1.00 (`custom_id` "spike-{runId}", request id "spike-refund1-{runId}"); e2 repeats that POST exactly; e3 GETs e1's refund; e4 refunds the rest of A (less e2's 1.00 if it was a second refund or its reply was lost); e4b GETs e1's refund again; e5 asks 1.00 more of the fully refunded capture under a new request id; e6 repeats e4's request. Each refund POST is one exchange: the spike's client doesn't resend a write (`writeRetries` 0), so a lost reply is "no answer", never a resend mixed into the answer. The block "Refund premises (DESIGN.md §19-§20)" answers P1, P2, P2b, P5 and P7. P3, P4 and P6 need the developer dashboard's webhook simulator and the sandbox webhook event log |

**Spike results, 3 Nov 16:06 (sandbox, app 1999c59; the full table is in the CTO's notes).**
- S1-S3, S6: an order with `payee.merchant_id` of another sandbox business account (the guide, DE) is created,
  approved by a sandbox buyer and captured by the operator's app: capture COMPLETED, `custom_id` echoed.
- S9: a German (EUR) guide account takes the EUR deposit as COMPLETED. The MU sandbox accounts hold USD.
- **S11: NO.** `userinfo` with the app's token answers 200 with only `user_id` and `sub`: no `payer_id`. The
  startup check as built refuses to start. **Verified instead:** `POST /v2/checkout/orders` with no `payee` (and
  `Prefer: return=representation`) echoes `purchase_units[0].payee.merchant_id` = the app owner's merchant id
  (equal to the dashboard's). The probe order is never approved and lapses.
- **S4: NO.** The operator's app gets 403 PERMISSION_DENIED refunding the guide's capture. `PayPal-Auth-Assertion`
  is refused (400 "No permissions to set target_client_id"), and Partner Referrals answers 403 NOT_AUTHORIZED:
  acting for a seller needs PayPal's partner features. **Open:** whether a REST app owned by the guide's own
  account can refund a capture the operator's app created (decides whether only the refund legs move to the
  guide's credentials, or the order too).
- S12 (P1, P2, P2b, P5, P7): not answered, because e1 was refused. Rerun on the existing capture once refunds work.

**S12, what each answer changes in the code.** P2 and P2b are read on the POST reply and on GET only; whether
refund *webhooks* carry them too is P3, read in the event log.

- **P1, dedupe (e2, e6).**
  - Both DEDUPED: the client's retry and the agent's resend are safe as designed, and I5 and F1 stay the backstop.
  - e2 NOT DEDUPED: one intent can cost two refunds. I5 and F1 hold the booking, but only after the money
    moved. The path to revisit is the client's own retry of a refund POST (`#api` retries a write with a
    request id once on a network error or a 5xx). Whether refund POSTs stop retrying and go straight to
    `refund_unconfirmed` is a CTO decision; the switch exists (`writeRetries: 0`, which the spike uses).
  - e2 refused: the client's retry and the resend are refused rather than replayed. A refused resend is
    held as `unknown` until its refund's own evidence settles it (§18), so this fails closed. The run is then
    not OK, since this answer is not the expected one. A refusal is a 422, or another 4xx that names at
    least one issue and is not 401, 403 or 429.
  - e2 or e6 "no answer": its reply was lost (a network error, a timeout or a 5xx), was a 2xx with no
    refund in it, or was a 4xx that isn't a refusal (401, 403, 429, or no issue named). PayPal may have
    refunded, so the premise reads unanswered and the run is not OK: rerun with a new order.
  - e2 DEDUPED, e6 refused: dedupe holds while the capture has room, but not once it is fully refunded. A
    resend after a lost reply of the refund that emptied the capture is held as `unknown`, as above.
- **P2, `custom_id` (reply, GET).** "yes": the service finds the booking by `custom_id` (`namesBooking`).
  "no": F2's capture link (P2b) is the only way the service finds it. The spike's `custom_id` equals the
  order's, as the service's does, so the run can't tell an echo from a copy of the capture's. The code doesn't
  need to.
- **P2b, the `up` link (reply, GET).** "yes": F2 works as built. "no" or "other", with P2 "no": a refund
  whose id is on no booking finds no booking. Then an unknown hold waits for a person, and I5 can't see a
  duplicate. With P1 NO as well, the code needs another way to find a refund's booking before the demo.
- **P5, `total_refunded_amount` (reply, GET, running total).**
  - absent: F1 is skipped and I5 alone applies.
  - present and a running total: F1 works as built.
  - only the refund's own amount, or a GET that shows the total from when that refund was made: F1
    under-detects, never over-holds, since `paypal_refunded_minor` keeps the largest total seen. I5 still
    applies. A larger total than the refunds made (fees, the gross, pending counted twice) would hold
    falsely, and F1's reading must change.
  - "GET after e4" answers the GET half: e4b reads e1 again once e4 has refunded the rest. "running total
    yes", or "no ..., as on e1's reply" for the total from when e1 was made.
  - "unanswered": e1's, e2's or e4's reply was lost or had no refund in it, so PayPal may have made a refund
    the spike never saw, and no sum can be trusted.
  - The run can't tell whether a PENDING refund is counted: sandbox refunds complete at once.
- **P7, the refusal issues (e5, e6).** The service matches only the first issue (`PayPalError.issue`) against
  `ALREADY_REFUNDED_ISSUES` (`CAPTURE_FULLY_REFUNDED`, `REFUND_AMOUNT_EXCEEDED` in `src/booking/service.ts`).
  If e5's first issue isn't in that list, a fresh refund refused on a capture refunded out of band is marked
  `failed`, not held as `already_refunded`. Then add the issue to the list. The spike prints every issue
  (`PayPalError.issues`).
- **P3, P4, P6 (not in the run).**
  - P3: `handleWebhook` takes every `PAYMENT.CAPTURE.REFUNDED` as a refund event and weighs its resource as
    the refund (`#refundEvidenceNow`), as the fake sends it. If the real resource is the capture, that
    premise and the evidence tests built on it are wrong for real events. If `REVERSED`'s resource is the
    capture, a reversal goes unnoticed until a person looks (§20).
  - P4: subscribe to the exact names (DEPLOY.md's TODO-CHECK).
  - P6: if a sandbox refund can't go PENDING and then FAILED, R9-3 and R9-4 (C2) stay tested on the fake only.

**The run's money guard** (`RefundBudget` in the spike) is asserted before every refund POST.
- The spike's client sends each refund POST once (`spikeClient`, `writeRetries` 0), so a POST is one
  exchange. A 401 isn't counted as one: PayPal refused the token without acting, and the client resends the
  request with a new token.
- A POST that may make a new refund (e1, e2, e4) must keep the worst case within A. The worst case counts the
  amount once for every exchange that may have reached PayPal: a lost reply, a 5xx and a 2xx with no refund
  in it all count. e2 counts as new.
- A probe (e5, e6) is sent only once PayPal's own replies show all of A refunded. The probe asks beyond A on
  purpose, but PayPal can only refuse it or replay an earlier reply. After a lost e1, e2 or e4 reply the
  replies never show all of A, so the probes aren't sent, P7 reads unanswered, and part of A can stay on the
  sandbox capture.
- The run is OK when every planned call ran: e1-e4 answer with a refund (e4 may be not needed, at A = 2.00
  without dedupe), e5 with a refusal (a 422, or another 4xx that names at least one issue and is not 401,
  403 or 429), and e6 with e4's refund or a refusal. e4b is informational. Any other answer, a 4xx that
  isn't a refusal included, is "no answer": the run is then SPIKE FAILED, and that line names each call,
  e.g. "SPIKE FAILED (e5: no answer (HTTP 429 is not a refusal))".

## 6. The agent's tools (one registry: `src/tools/`; served to the model and over MCP)

| Tool | Input | Effect | Money? |
|---|---|---|---|
| `search_guides` | `area?`, `activity?`, `date?`, `language?` | Lists seed guides that match | no |
| `request_quote` | `guide_id`, `date`, `party_size`, `activity`, `note?` | Creates a booking and an operator link; the guide is "notified" | no |
| `get_booking` | `booking_id` | Reads every pending refund from PayPal first (§18 I4), then: status, quote, mandate state, order and capture ids, refunds (done, pending, in review and why), the reschedule and, when the guide can't answer it now, why (`reschedule_hold`, §17) | no |
| `propose_mandate` | `booking_id` | Builds the mandate from the frozen quote; the step-up code goes to the traveller channel only | no |
| `create_order` | `booking_id` | **Only** with an approved, unexpired, unused mandate whose quote hash, amount and payee match. Creates the order with payee = the guide; returns the approve link | prepares a payment |
| `get_order` | `booking_id` | `GET /v2/checkout/orders/{id}` | no |
| `capture_order` | `booking_id` | Idempotent capture, only once the order is APPROVED | yes (traveller → guide) |
| `check_weather` | `booking_id` | Cyclone alerts for the booking date and a plain explanation | no |
| `propose_reschedule` | `booking_id`, `new_date` | Asks the guide on the operator page; refused once a refund has started (§16) | no |
| `refund_payment` | `booking_id`, `amount?` | Only when the policy (§2.2) allows; partial or full. No definitive answer: `refund_unconfirmed` (it may have gone through; calling again resends the same refund). An earlier refund PayPal confirmed since is reported (`acknowledged`) and nothing is sent (§18) | yes (guide → traveller) |

**PayPal Agent Toolkit plug-in point.**
- `src/paypal/api.ts` defines `PaymentsApi`: `createOrder`, `getOrder`, `captureOrder`, `refundCapture`, `getRefund`, `verifyWebhookSignature`.
- Today one class implements it: `PayPalRestClient` (sandbox). `FakePayPal` is a `fetch` stand-in underneath
  that client, so tests and the offline demo run the real client code.
- `@paypal/agent-toolkit` (Apache-2.0; can't be installed here) has `create_order`, `get_order`, `pay_order` and
  refund tools. It plugs in as a second `PaymentsApi` adapter that calls the toolkit's functions. Our booking service
  stays the only caller, so the mandate check still runs first. **We do not hand the toolkit's tools straight to the
  model**: that would let the model create orders with no mandate. **UNVERIFIED:** whether the toolkit lets you
  set `purchase_units[].payee` (its `create_order` parameters are not documented in what I could read).

**The model:**
- `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` select an OpenAI-compatible `POST {base}/chat/completions` with
  `tools`; OpenRouter is planned.
- With no key, the **scripted model** runs: deterministic tool calls driven by the conversation. The tests and the
  offline demo use it, and the page labels it "scripted model".
- Events (the guide priced, the mandate approved, paid, a cyclone) enter the conversation as notes that start with
  `[event]`.

## 7. HTTP surface

| Route | What |
|---|---|
| `GET /` | Chat page with these panels: the conversation, the approval card, the ledger (the page shows the chain status by itself, "Chain OK" or where it broke; there is no button), the guide's phone (operator link), the demo inbox (step-up code), and Demo controls in fake and sandbox mode: "Simulate a cyclone warning (demo)" and "Start over" (§14). Fake mode also has the stand-in checkout and shows the guide's fake balance |
| `POST /api/chat` | `{message?}` → the agent loop's reply plus the booking snapshot, for the **session's** current conversation (see §11) |
| `GET /api/state` | The session's bookings, mandates, ledger rows, inbox; a `conversation_id` parameter is ignored |
| `POST /api/conversations` | Starts a new conversation in this session ("Start over") |
| `GET /api/ledger/head` | The ledger checkpoint kept outside the database `{count, head}` and the verify result against it |
| `POST /api/mandates/{id}/approve` | `{code}`. **Human only**: no tool can call it; 404 unless the session owns the booking |
| `GET /o/{token}`, `POST /o/{token}` | The operator page: price, accept or decline a reschedule, offer a refund. The token is 256-bit base64url and stored as sha256; there is no login. A reschedule answer names the proposal it answers (hidden `proposal`); one for an earlier proposal, or none, answers 422 and the page shows the current question (§17) |
| `GET /paypal/return`, `GET /paypal/cancel` | The PayPal redirects, both to `/` (never a conversation id). Return captures if the session owns the booking |
| `POST /webhooks/paypal` | Verify via call 7, log to the ledger once, process. Only completed processing makes a redelivery a duplicate; a processing failure answers 500 |
| `POST /mcp` | The tools over MCP (stateless). Off unless `MCP_DEMO_PASSCODE` is set (Bearer); scoped to the conversation `mcp` |
| `GET /fake-paypal/checkout?token=` | **Fake mode only**: a stand-in buyer approval page |
| `POST /api/demo/cyclone` | Fake and sandbox mode (live is refused at startup). Needs an existing session (401, and it never creates one). **Sandbox:** `{booking_id}` of a booking the session owns (else 404) and has paid with no refund under way (`captured`, no refund being sent or pending; else 409 with the reason, and nothing is saved); posts one simulated warning for that booking's day, once, and calls no payment API (§14). **Fake:** unchanged, a demo-feed alert around every booking of the tab's conversation |
| `GET /healthz` | `{ok, mode}` |

## 8. Three-minute demo script (from the report, §6 B)

- **0:00** The problem: guides are booked over WhatsApp, and deposits are awkward. Small operators aren't on
  booking platforms.
- **0:20** The chat request: "Find me a hiking guide for Le Morne on Thursday and hold the spot." Ambree lists 2
  guides, picks one and asks for a price.
- **0:50** The guide's phone: the operator link shows the request. The guide types EUR 80 total and EUR 30 deposit.
- **1:20** The approval card: EUR 30.00 to "Lantern Ridge Walks (demo)" (on the hosted sandbox, the payee is the
  one sandbox business account that plays every guide), quote hash, expiry 15:00, step-up code from the inbox,
  Approve.
- **1:40** The agent creates the order (payee = the guide). Then the PayPal sandbox checkout, logged in as the
  sandbox traveller, pays the guide.
- **2:05** The return capture lands, and the webhook is verified. The ledger rows appear with their hashes, and
  the chain status under the ledger says "Chain OK" by itself. The guide's sandbox balance goes up (shown in the
  PayPal sandbox dashboard).
- **2:25** Now that the deposit is paid, "Simulate a cyclone warning (demo)" puts a simulated warning on Thursday
  for this booking only (a real GDACS warning can't be triggered on demand; before payment the button is off and
  says to pay first). Ambree explains the risk, says it is simulated, and proposes Saturday. The simulated warning
  alone allows no refund. The guide declines, and that decline lets Ambree refund the deposit (partially, if the
  guide keeps a fee; PayPal's note reads "the guide declined the reschedule"), and the refund webhook is logged.
- **2:50** Architecture slide: never custody. The order's payee is the guide, our account is never the payee, and
  the mandate is enforced in code.

## 9. Judge steps (README carries the final version)

1. Open https://paypal.ambree.ai (or run `npm start` locally with no env: the fake PayPal and scripted model, end to end).
2. Type the request. Open the "guide's phone" link and set a price.
3. Read the code from the demo inbox and approve the mandate.
4. Click "Pay the guide". On the hosted sandbox instance, log in with the sandbox buyer account listed in the
   README (the CEO creates it; the credentials are published for judges as the rules ask). On the fake, click
   approve.
5. Watch the ledger fill in; the chain status under it says "Chain OK" by itself.
6. After paying, press "Simulate a cyclone warning (demo)" (Demo controls; it stays off, saying why, until the
   booking is captured). Follow Ambree's reschedule and decline it as the guide: the guide's decline, not the
   simulated warning, allows the refund. See the refund.

## 10. Deploy shape (as hosted; the steps are in DEPLOY.md)

- **Image:** `paypal.ambree.ai`, its own namespace `paypal` on the Oracle k3s host, as `qloo` did.
  - Image `oraculum/ambree-paypal:<sha7>`, built on the host, `imagePullPolicy: Never`.
  - Traefik Ingress with a Let's Encrypt certificate.
  - Runs as user `node` with a read-only root filesystem; the only writable path is `/data`, the PVC `paypal-data`
    (64Mi, `local-path`, made by the admin), which holds the SQLite file. One replica, `Recreate`.
- **Secret:** `paypal/paypal-secrets`, made by hand, holds `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
  `PAYPAL_WEBHOOK_ID`, `LLM_API_KEY` and `MCP_DEMO_PASSCODE`. Every key is required (no `optional`), so the pod
  doesn't start without it; there is no fake-PayPal fallback on the host. The merchant ids, `LLM_BASE_URL` and
  `LLM_MODEL` are plain values in the Deployment.
- **Network:** egress on TCP 443 only; the target hosts are `api-m.sandbox.paypal.com` and the LLM host. A
  NetworkPolicy can't name hosts, so this uses the same form as alexa/qloo.
- **Data:** the ledger survives restarts until 15 Dec on the PVC.
- **Webhook:** set up in the sandbox app for `https://paypal.ambree.ai/webhooks/paypal`. Its id goes into the Secret.
- **New env names** (added after the review): `PAYPAL_OPERATOR_MERCHANT_ID` (required in sandbox mode; the
  `*_EMAIL` variables are refused) and `MCP_DEMO_PASSCODE` (optional; without it MCP is off).

## 11. After the review (fix phase, 31 Oct)

A second review found ten issues; all were fixed (`cw-out/2026-10-31/paypal-fix/SUMMARY.md`). The rules
that changed:

- **Traveller authority.**
  - Cookie `amb_sid`: 256 random bits, HttpOnly, SameSite=Lax, Secure when `PUBLIC_URL` is https. It is
    stored as a sha256 in the `records` table (`session`), mapped to server-issued conversation ids.
  - Tools resolve every `booking_id` through `BookingService.owned(id, conversation)`. Another
    conversation's booking reads as "not found".
- **Operator payee.**
  - Startup refuses a guide payee equal to a configured operator identity: email case-insensitive, merchant
    id exact.
  - `createOrder` and capture refuse an operator payee or a missing one.
  - An email can't be matched against a merchant id; configure both.
- **Order validation** (`orderProblem`), before capture and on the capture reply:
  - exactly 1 purchase unit;
  - a payee equal to the mandate's and not the operator's;
  - the mandate's amount and currency;
  - `custom_id` or `reference_id` = the booking id.
  - **UNVERIFIED:** that `GET /v2/checkout/orders/{id}` echoes `purchase_units[].payee` for a third-party
    payee. If it doesn't, validation fails closed (`needs_review`, no capture). Spike S6 must look at this.
- **Create failures.**
  - Definitive (400/401/403/404/422, auth or invalid request): the mandate is spent and the booking returns
    to `priced`.
  - Ambiguous (timeout, network, 5xx, 409/429, or a reply that isn't JSON): `order_pending` stays set. A retry
    uses the same nonce, but only while the mandate is unexpired; after expiry the booking returns to
    `priced` with `order.abandoned`.
- **Captures.**
  - `COMPLETED` is paid. `PENDING` becomes `capture_pending` and is refreshed by `GET` on the next
    `captureIfApproved` (any `PAYMENT.CAPTURE.*` webhook calls it).
  - `DECLINED` or `FAILED` becomes `capture_failed`. An amount mismatch becomes `needs_review`.
- **Refunds.**
  - Each refund is a `RefundOp` `{n, request_id, amount_minor, full, reason, status}`, persisted before it
    is sent.
  - The status moves `sending → pending | completed | failed`. An unresolved `sending` op is resent
    unchanged on the next refund call.
  - Pending and sending amounts are reserved but not counted as refunded. `PAYMENT.CAPTURE.REFUNDED`
    triggers `refreshRefunds` (a `GET` per pending op).
  - The returned amount is reconciled (`refund.reconcile_failed`).
- **Webhooks.** `webhook_events` has `status` (received, processing, completed or failed), `attempts` and
  `logged`. The ledger row is written once.
- **Ledger.**
  - `verify()` alone can't see a deleted tail or a rollback. `verify(checkpoint)` can, where the checkpoint
    is the last head kept outside the database: in process memory, logged as `ledger_head` on every
    append, and served at `/api/ledger/head`.
  - After a pod restart, the in-memory checkpoint starts from the database. Comparing it with the last
    logged `ledger_head` is the operator's check.

## 12. After the re-check (fix round 2, 31 Oct). This supersedes §11 where they differ

- **Merchant ids only.** This replaces §11's email comparison.
  - `samePayee` and `isOperator` compare `merchant_id` only; a payee with no merchant id never matches, and
    counts as possibly the operator.
  - Config requires `PAYPAL_OPERATOR_MERCHANT_ID` and `PAYPAL_GUIDE_PAYEE_MERCHANT_ID` in sandbox mode and
    refuses the `*_EMAIL` variables.
  - Seed guides carry invented 13-character merchant ids.
  - The app sends orders with `payee.merchant_id`. Before capture, the order's `payee.merchant_id` must
    equal the guide's and must not be the operator's.
  - **UNVERIFIED (spike S6):** whether order replies echo `payee.merchant_id`; without it, capture is refused.
  - Also **UNVERIFIED:** that merchant ids are 13 capitals and digits (the code allows 8-20).
- **The page's payment line** (`public/labels.js` `paymentLine`):
  - "Paid" only for captured, partially refunded or refunded bookings;
  - "Payment pending" for `capture_pending`;
  - "Payment failed" for `capture_failed`;
  - "Payment needs review" otherwise.
- **Refund events.** `PAYMENT.CAPTURE.REFUNDED`, any `PAYMENT.REFUND.*` (e.g. `PAYMENT.REFUND.FAILED`;
  the exact names are **UNVERIFIED**) and, since §20, any event whose `resource_type` is `refund` (e.g.
  `PAYMENT.CAPTURE.REVERSED`) call `refreshRefunds`. A terminal status other than COMPLETED/PENDING
  marks the op `failed`, which releases the reservation.
- **Refund reconciliation fails closed.** For a COMPLETED or PENDING reply, the amount must exist and equal
  the op's currency and minor units. Otherwise the op and the booking go to `needs_review`: the op stays
  reserved, nothing is counted, and nothing is announced.
- **Mutation checks** (`refuseMutation`, run before any session lookup or creation):
  - every `/api/*` POST needs `Content-Type: application/json`;
  - `/api/*`, `/o/{token}` and `/fake-paypal/*` POSTs carrying an `Origin` need it to equal
    `new URL(PUBLIC_URL).origin`.
  - The operator page stays a form POST: it is a no-cookie capability URL, so a forged form can't act
    without the token. The Origin check still applies.
  - The webhook (PayPal server to server, signature-verified) and `/mcp` (Bearer passcode) are outside
    these browser checks.
  - `Referrer-Policy` is `same-origin`: `no-referrer` makes Chrome send `Origin: null` on form POSTs.
- **Per-tab conversations.**
  - Sessions start with no conversation; `POST /api/conversations` adds one and returns its id.
  - The page keeps the id in `sessionStorage` and sends it on every call (`?conversation_id=` on GET, in
    the JSON body on POST). The server serves it only if the session owns it, else 404.
- **Schema version.** `PRAGMA user_version = 2` (`SCHEMA_VERSION` in `src/store/db.ts`). Opening a file of
  any other version (an unstamped build-1 file reads as 0) throws `SchemaError`. There are no migrations
  until something is deployed. This also covers the re-check's legacy-records point: records without
  `refund_ops` can't be loaded at all.

## 13. Fix round 3 (31 Oct)

- **Review is sticky.** While any `RefundOp` is `needs_review`:
  - the booking stays `needs_review`, even when another op completes;
  - `refund()` refuses new refunds and retries of a `sending` op with
    `ServiceError("refund_under_review")`;
  - `refreshRefunds` may still record other ops' real completions (money did move), but it never clears the
    review.
- **Operator identity confirmed with PayPal** (`App.listen()` → `confirmOperator()`).
  - **What the docs say (read 31 Oct):**
    - `/v1/oauth2/token` returns `scope, access_token, token_type, app_id, expires_in, nonce`, and no
      merchant or payer id (https://developer.paypal.com/api/rest/authentication/).
    - `GET /v1/identity/openidconnect/userinfo` "Shows OpenID Connect user profile information". Its sample
      reply has `user_id, sub, name, email, verified_account, account_type …` but no `payer_id`, and the
      page says neither which token it takes nor that it describes the app owner
      (https://developer.paypal.com/docs/api/identity/v1/userinfo-get).
    - **No documented call is known to return the REST app owner's merchant id for an app token.**
  - **What the code does:**
    - `PaymentsApi.getOperatorIdentity()` calls `GET /v1/identity/openidconnect/userinfo?schema=openid`
      with the app token and reads `payer_id` (13-character-style ids only).
    - Startup refuses when the call fails, when `payer_id` is absent, when it isn't
      `PAYPAL_OPERATOR_MERCHANT_ID`, or when it is a guide's merchant id.
    - The fake answers the same call (`ownerMerchantId`, default `AMBREEOPER001`).
  - **Opt-out:** `PAYPAL_OPERATOR_IDENTITY=config-only` is explicit and logged as a warning, and `/healthz`
    reports `operator_identity: "config-only (unconfirmed)"`. Use it only if S11 shows the call can't
    confirm the owner, until a documented call is found.
  - **UNVERIFIED: S11** (the spike's "a2 identity" row).

## 14. The hosted demo (2 Nov)

On the hosted site (PayPal mode `sandbox`), `POST /api/demo/cyclone` answered 404 and the page hid the Demo
controls, so the cyclone → reschedule-or-refund scene (§8 2:25, README judge step 7) could not be shown. Real
GDACS warnings can't be triggered on demand.

- **The simulation, sandbox mode** (`BookingService.simulateCyclone`):
  - It runs after the usual mutation checks (Origin, `Content-Type: application/json`). It needs an existing
    session cookie (401 otherwise; the route never creates a session).
  - It takes `{booking_id}`, which must belong to one of the session's conversations (404 otherwise, as for
    a mandate approval).
  - It saves one alert on the booking: `simulated_alert`, source `simulated`, from and to the booking's day,
    level orange. It goes on the booking, not in the shared demo feed, so another booking (or another
    judge's session) on the same day never sees it. The record field is optional, so `SCHEMA_VERSION` stays 2.
  - It logs `weather.simulated_alert` and emits the agent event "Simulated cyclone warning (demo) for
    {date}, not a real warning: …".
  - It is idempotent and runs one at a time with the booking's other steps (`#serial`; since round 7 every
    step, §16): a second call (or a racing one) answers `posted: false` with no new row or event, and a press
    while a capture or refund is waiting on PayPal waits for it.
  - Only a paid (`captured`) booking with no refund under way takes it (round 8, §17); the agent can only move
    such a booking, so a warning spent earlier could never lead to the reschedule. Any other status answers
    409 and records nothing (no `simulated_alert`, no ledger row, no event), with one message per group:
    - not paid yet (requested, priced, mandate_proposed, mandate_approved, order_created; reason `not_paid`):
      "pay for the booking first, then simulate";
    - finished or still in processing (declined, capture_pending, capture_failed, needs_review,
      partially_refunded, refunded; reason `cannot_simulate`): it can't be simulated now, and why;
    - captured, but a refund being sent or pending at PayPal (reason `cannot_simulate`): "a refund of the
      deposit has started, so the trip can't be moved".
  - It calls no payment API. The agent reacts to the event (check_weather → propose_reschedule). The simulated
    warning never allows a refund by itself (§2.2 rule (a) takes real feed alerts only): a refund still needs
    the guide's offer or the guide declining the new date. A traveller who asks for a refund before the guide
    answers is refused. In the demo the refund reason (and so PayPal's `note_to_payer`) reads "the guide
    declined the reschedule".
  - Once the booking is no longer captured (e.g. refunded), the guide's page hides "Move the trip?" and an
    answer is refused (`wrong_state`).
- **Fake mode** keeps its conversation-wide demo-feed raise (`weather.alert`, ±1 day). That is a feed alert
  (source `demo`), so refund rule (a) applies to it as before.
- **Live mode** can't run it: `loadConfig` and `PayPalRestClient` refuse any base URL but the sandbox's
  before the server starts.
- **The page** (`public/labels.js` `demoView`):
  - Demo controls show in fake and sandbox mode: "Simulate a cyclone warning (demo)", which acts on the
    tab's newest booking (sandbox: enabled only when that booking is captured and its `refund_pending` is
    null, with the reason shown otherwise; `simulateControl`), and "Start over", which adds a new
    conversation to the caller's own session and switches this tab to it.
  - Only the guide's fake balance stays fake-only: it is the fake's own bookkeeping, and the server sends
    `null` in sandbox mode.
  - The stand-in checkout (`/fake-paypal/checkout`) exists only in fake mode.
- **Tests:** `test/fix4-hosted.test.ts` runs the app in sandbox mode with no network
  (`AppOptions.paypalFetch`, tests only: a stub that refuses every PayPal call, or the fake). The Playwright
  project `sandbox-like` (`e2e/serve-sandbox.ts`) runs the whole hosted path in a browser, using a stand-in
  buyer checkout on its own port: Simulate is off until the booking is paid, a refund request is refused until
  the guide answers, and the guide's decline refunds.
- **After the review (2 Nov), also:**
  - A save that follows an await (a PayPal call or the weather feed) merges its own fields onto the booking
    as stored then, never onto the copy read before the await: the capture's saves (`#reconcileCapture` and
    the needs_review save before capture), the refund's reservation after `refundReason`, and every refund
    reply (`#applyRefund`, from `refund` and `refreshRefunds`). A change made meanwhile (the guide's refund
    offer, a simulated warning) survives.
  - `Content-Type` is matched case-insensitively by both the 415 check and the JSON body reader
    (`isJsonRequest` in `src/app.ts`), so "Application/JSON" is read, not dropped.
  - `test/fix5-review.test.ts` covers the review's findings, with deterministic races: a gate holds one
    PayPal reply (or feed lookup) while the test changes the booking.

## 15. Round 6: the refund reason, its refusal, and a move during a refund (2 Nov)

Four findings from the independent reviewers, each with a test that failed at 09d7db8
(`test/fix6-*.test.ts`; the races are deterministic, held by `test/helpers/race.ts`'s gate):

- **R1, the reason holds on the booking it reserves on** (`refund` → `#reasonNow`). The status, the guide's
  offer and a declined reschedule are read on the booking as stored after the weather feed answered. A feed
  warning counts only if that booking's date is still the date that was looked up. A date the guide moved
  meanwhile is looked up once more; a second move answers `date_changed` (retryable, nothing reserved or
  sent). `refundReason(b)` keeps its contract (`check_weather`'s `refund_allowed`). Since round 7 (§16) the
  service's own steps queue behind the refund, so only a writer outside the service can move the date
  meanwhile; `#reasonNow` became `#reserveRefund`.
- **R2, each refusal says why.** The simulated-warning note ("doesn't allow a refund by itself") appears only
  when that warning is the only would-be reason: the booking is `captured` or `partially_refunded`, the
  warning covers its date, and there is no offer and no declined reschedule. A `refunded` booking is told
  the deposit was already refunded; an unpaid or held booking's refusal names its status. The code stays
  `refund_not_allowed`.
- **R3, no move during a refund.** A refund being sent or pending leaves the booking `captured` until PayPal
  answers. `answerReschedule` refuses (`wrong_state`), and the guide's page hides "Move the trip?", while any
  refund operation is in a status other than `failed` (`refundStarted`, `rescheduleAnswerable`).
- **R4, a full refund withdraws a waiting move.** In `#applyRefund` (so from `refund` and `refreshRefunds`), a
  refund that makes the booking `refunded` turns a `proposed` reschedule into `withdrawn` in the same save
  and logs `reschedule.withdrawn` (`from`, `to`, `reason: "the deposit was refunded"`) after
  `refund.completed`. The traveller's card says "withdrawn, because the deposit was refunded"
  (`labels.js` `rescheduleLine`). A partial refund left the move `proposed` (superseded in round 7, §16: it
  withdraws it too). The status is additive and the field optional, so `SCHEMA_VERSION` stays 2.
- **Fake mode:** unchanged in behaviour. Its demo-feed raise is a feed warning (rule (a)); R1–R4 apply in
  every mode, and its e2e refund path declines the move before the refund, so nothing is withdrawn there.

## 16. Round 7: one booking's steps never interleave (2 Nov)

Review rounds kept finding lost updates and stale decisions: only the money steps queued on the booking
(`#serial`), so the guide's page, the agent's mandate and move tools, the traveller's approval and the
webhook's own dedupe and row could land between a step's read and its save, across an await. Each finding
has a test that failed at the starting code (`test/fix7-serial.test.ts`: 26 of 35 failed; the races are
deterministic, held by `test/helpers/race.ts`'s gate, or chained 0 to 5 microtasks after the feed's reply).

- **S1, one queue per booking.** Every public step that changes a booking, or decides money on it, runs its
  whole read-decide-write in `#serial(bookingId)`, one at a time per booking: `priceQuote`, `declineRequest`,
  `proposeMandate`, `approveMandate` (on the mandate's booking), `createOrder`, `captureIfApproved`,
  `handleWebhook` (after verifying: the dedupe, the ledger row and the reaction), `simulateCyclone`,
  `announceCyclone` (each booking's lookup and announcement), `proposeReschedule`, `answerReschedule`,
  `offerRefund`, `refund` and `refreshRefunds`. A step sent while another waits on PayPal or the weather
  feed waits for it, then decides on the booking as that step left it. Different bookings never wait for
  each other. A queued step never calls another queued public method for the same booking (it would wait
  for itself): it calls the unqueued `#…Now` body (`#captureNow`, `#refreshNow`, `#answerNow`, …).
  `requestQuote` isn't queued: it creates the booking, whose id nobody holds yet. The operator page's
  `applyOperatorAction` and the approve route await the steps, which are now async.
- **S2, no move once a refund has started.** `proposeReschedule` refuses (`wrong_state`, "A refund of the
  deposit has started, so the trip can't be moved.") while any refund operation is in a status but
  `failed`, as `answerReschedule` already did (§15 R3). `#applyRefund` withdraws a `proposed` move whenever
  a refund completes and leaves the booking `partially_refunded` or `refunded`, logging
  `reschedule.withdrawn` with reason "part of the deposit was refunded" or "the deposit was refunded"; a
  booking held for review keeps its move. The card says "withdrawn, because part of the deposit was
  refunded." on a partially refunded booking, and the agent's `refunded` event ends "The move to {date} is
  withdrawn: the guide is no longer asked."
- **S3, the reservation on one fresh read.** `refund` → `#reserveRefund` decides the reason and saves the
  reservation synchronously on one `must(bookingId)` taken after the last await (the feed lookup); with S1,
  a guide's answer sent in the microtasks after the feed replied queues behind the refund and is decided
  on the booking the refund left (never overwritten).
- **The model** is told what `withdrawn` and `date_changed` mean (the system prompt, and the `get_booking`,
  `propose_reschedule` and `refund_payment` descriptions); the scripted model is unchanged.
- **Fake mode:** the demo control's `announceCyclone` now queues per booking, so a press while a refund is
  held at PayPal waits for it and reads the booking as the refund left it. Otherwise unchanged.

## 17. Round 8: an answer names its move; a lost refund reply; what a held move says (2 Nov)

Five findings from the independent reviewers, each with a test that failed at 7777925
(`test/fix8-*.test.ts`: 21 of 27 failed; the race is the guide's own two pages, read from the rendered HTML).

- **D1, an answer names the move it answers** (`fix8-stale`). The accept and decline forms posted only
  `action`, so a page left open on one proposal answered whatever was proposed when it was clicked: a stale
  "No, I can't" declined a later date the guide never saw (and unlocked the refund), a stale "Yes" moved the
  trip there. Each proposal is now numbered (`reschedule.n`), and both forms carry `proposalKey(b)`
  ("n:new_date") in a hidden `proposal` field. `answerReschedule(token, accept, proposal?)` refuses an
  answer naming any other key (`stale_reschedule`; nothing saved, logged or announced), and the page shown
  after the post asks the current question. The page always sends the key, so a post without one (a page
  rendered before round 8) is refused too; the service's own callers may leave it out. `summary().reschedule`
  stays `{new_date, status}`.
- **D2, no simulated warning during a refund** (`fix8-simulate`). `#simulateNow` refuses (`cannot_simulate`)
  a captured booking whose refund is being sent or pending, as `proposeReschedule` does since §16 S2, so the
  once-only warning isn't spent on a booking the agent can't move. The page's control is off with the same
  reason while the newest booking's `refund_pending` is set (on a captured booking that is exactly
  `refundStarted`).
- **D3, a refund whose reply was lost** (`fix8-lostreply`). PayPal refunded, but both client attempts lost the
  reply, so the operation stayed `sending`; its `PAYMENT.CAPTURE.REFUNDED` (custom_id = the booking) only
  refreshed `pending` refunds and was marked completed. Now the webhook's refund branch also runs
  `#recoverSendingNow`: when the event's refund is unknown to the booking, names it, and an operation is
  `sending` (at most one is), the refund is read back by GET (nothing is sent, so nothing can be refunded
  twice), logged `refund.recovered`, and recorded on that operation by `#applyRefund` (which fails closed on
  another amount or currency, and withdraws a waiting move on completion). Only COMPLETED or PENDING is
  recorded; a failed refund that can't be tied to the operation leaves it `sending` (superseded in round 9,
  §18 I2: a FAILED or CANCELLED one of the operation's amount fails it and frees the deposit). A GET that
  fails answers 500, so PayPal redelivers. And a resend (the operation was already `sending`) that PayPal
  refuses outright no longer frees the reservation: the first send may have refunded (a request id no
  longer deduped is answered e.g. 422 `CAPTURE_FULLY_REFUNDED`), so the operation and the booking go to
  `needs_review` (`refund.resend_refused`; the caller gets `refund_under_review`). A first send refused
  outright is `failed` as before (superseded in round 9, §18 I1: not when an attempt of it may have reached
  PayPal inside the client, nor when PayPal says the money already moved; and such a hold can now clear). **UNVERIFIED** (spike): that the refund resource in PayPal's refund
  webhooks carries the `custom_id` we send. Without it a refund with no known id finds no booking, and the
  event completes unused as before (the next `refund_payment` still resends the operation). Corrected in
  round 10 (§19 F2): that resend holds only for an operation still `sending`, not for one held for an
  unknown outcome; and a refund without custom_id now finds its booking by the capture in its `up` link.
- **D4, a held move says what it waits on** (`fix8-hold`). A move proposed before a refund started stays
  `proposed` while that refund is being sent or pending, and for good once the booking is held for review,
  but the guide can't answer it then. `summary()` adds `reschedule_hold` (`rescheduleHold(b)`: null when
  nothing is proposed or the guide can answer; otherwise "a refund of the deposit is under way" or "the
  booking is held for review"). It is derived, not stored: a pending refund that fails makes the move
  answerable again. `get_booking`'s description and the system prompt define `proposed` as answerable only
  while the booking is captured and no refund has started; `refund_payment`'s says a pending or in-review
  refund puts a waiting move on hold. The card reads "Reschedule to {date}: proposed, but the guide can't
  answer it while {hold}."
- **D5, the card after a partial refund and a mismatched reply** (`fix8-card`). The withdrawn reason follows
  the amounts (refunded less than captured: "part of the deposit was refunded"), not the status, which may
  be `needs_review` by then. `summary()` adds `refund_review` (the amount held for review), and
  `paymentLine` gives it its own line ("A refund needs review: PayPal's reply about the refund of {amount}
  didn't match what was sent ... The deposit ... was paid"), instead of the capture's "did not match the
  approved mandate".
- **Earlier tests** that posted a bare `{action: accept/decline_reschedule}` post what the page's form posts
  (the proposal key; read from the page in the HTTP tests). `SCHEMA_VERSION` stays 2: `reschedule.n` is
  optional.

## 18. Round 9: a refund whose outcome is unknown ends the same in every order (2 Nov)

R8-1 to R8-4 were one defect. A refund operation whose outcome is **unknown** (an attempt may have reached
PayPal, but no definitive reply came back) was resolved by whichever signal came first: the reply to the
client's own retry inside `PayPalRestClient`, the refund's webhook, or the agent's next `refund_payment`.
Round 8 handled one order; the reviewers found four more:

- **R8-1:** a PENDING refund whose reply was lost, then failed at PayPal. Its `PAYMENT.REFUND.FAILED` was
  dropped (only COMPLETED or PENDING was recorded). The resend then got PayPal's replayed PENDING reply, and
  nothing ever read it again, so the booking stayed "refund under way" for good.
- **R8-2:** attempt 1 refunded and lost its reply (a network error or a 5xx); the client's retry was refused
  422. The service saw only that 422 and released the reservation (`failed`), so the booking said nothing
  was refunded while the guide's balance was 0. In the partial case a second refund went out.
- **R8-3:** the webhook recorded a lost-reply partial refund, and then the agent's retry of the same 10.00
  reserved a second operation and refunded again.
- **R8-4:** the resend was refused before the webhook arrived, so the booking was held for review, and the
  webhook that would settle it was then ignored. That hold never cleared.

The code now keeps four invariants whatever the order.

- **I1, maybe-delivered is sticky.** `PayPalError.maybeDelivered` (`src/paypal/errors.ts`) is set by the
  client when this call, or any earlier attempt of it inside `#api`'s retry, ended in a network error, a
  timeout or a 5xx (`src/paypal/client.ts` `#api`: a local flag set before each retry, copied onto the error
  the call ends with). A 2xx reply that couldn't be read sets it too: PayPal acted on the request. A 401 the
  client refreshes past does not. In `refundPayment`'s catch the first statement saves `op.maybe_sent = true`
  when the error isn't a plain refusal or carries `maybeDelivered`. `#reserveRefund` saves it before a
  resend, since a `sending` operation's earlier send may have arrived. A definitive refusal of a `maybe_sent`
  operation then holds the operation and the booking for review with the reservation kept
  (`review_cause: "unknown"`; `refund.resend_refused` on a resend, `refund.retry_refused` when the client's
  own retry was refused). A first send refused with `CAPTURE_FULLY_REFUNDED` or `REFUND_AMOUNT_EXCEEDED`
  (the refund issues the repo models that say money already moved) is held too (`review_cause:
  "already_refunded"`, `refund.already_refunded`), not failed. That hold never clears: the refusal wasn't
  this operation's own outcome. It is also the safety net for a `PaymentsApi` adapter that can't report
  `maybeDelivered`, such as an Agent Toolkit adapter (§6). Any other first-send refusal is `failed` as
  before.
- **I2, evidence resolves the unknown operation.** `unknownOps(b)` holds the operations whose outcome is
  unknown: `sending`, or `needs_review` with `review_cause: "unknown"`. `assertOneUnknown` keeps it to at
  most one. It runs in `#reserveRefund` before anything is decided or sent, in `#setOp`, on every save in
  `#applyRefund`, and in `unknownOp`; a booking that breaks it (only a writer outside the service could) is
  refused with an internal error and nothing is sent. A refund webhook (`PAYMENT.CAPTURE.REFUNDED` or any
  `PAYMENT.REFUND.*`, any status) runs `#refreshNow` (the strict one) and then `#resolveUnknownNow`. When the
  event's refund is new to the booking and names it (`custom_id`), the refund is read back by GET. If the GET
  reply names the booking too (or names none) and carries the operation's amount and currency, it settles
  the operation through `#applyRefund`: COMPLETED becomes completed, PENDING becomes pending, FAILED or
  CANCELLED becomes failed and frees the reservation (`refund.recovered`, `from: sending | needs_review`).
  A COMPLETED or PENDING refund of another amount still holds the operation for good (`review_cause:
  "mismatch"`, `refund.reconcile_failed`), as before (superseded in round 10, §19 I5: such a refund doesn't
  match the operation, so it is held as its own unexplained entry and the operation stays unknown). A FAILED or CANCELLED refund of another amount moved no
  money and isn't this operation's. It is logged (`refund.evidence_unmatched`), and the operation stays
  unknown and reserved. Holding a booking for good over a refund that moved nothing would be new behaviour,
  so this reading of "a mismatch holds for review" is the CTO's to confirm (kept in round 10, §19). `#applyRefund` now derives the
  booking's status from its refunds (`statusFromRefunds`: any operation in review means `needs_review`;
  otherwise `refunded`, `partially_refunded` or `captured` by what was refunded). So a booking held only by
  an unknown outcome leaves review once that is settled, and a waiting move is withdrawn if money came back
  (§16 S2). A mismatch or an already-refunded hold keeps the booking in review. So does a capture or order
  hold: a booking in review with no refund operation in review is never touched (`heldElsewhere`). An
  operation held before round 9 has no `review_cause` and counts as `mismatch` (fail closed).
- **I3, one intended refund, one operation.** When `#applyRefund` settles an operation from evidence it
  sets `acknowledged: false`, because the `refund_payment` call that sent it never heard the answer. In
  `#reserveRefund`, after the review check and the resend of a `sending` operation, such an operation is
  acknowledged (`true`, logged `refund.acknowledged`). If it is completed or pending, the call returns it and
  sends nothing (`refundPayment` returns `{ booking, acknowledged }`, and `refund()` returns the booking). If
  it failed, the call goes on to reserve a new operation as usual. Any amount the agent asks for on that call
  is ignored, as for a resend: after a call that ended without an answer, the next call is its retry. The
  `refund_payment` tool turns a non-definitive PayPalError into `refund_unconfirmed`: "PayPal gave no
  definitive answer (...), so the refund may have gone through. Calling refund_payment again resends the
  same refund with the same PayPal-Request-Id, so PayPal can recognise it; if PayPal reports a second refund
  anyway, the booking is held for review and nothing more is sent. get_booking shows the current state."
  (Until §20 it said "never refunds twice", which holds only if PayPal dedupes.) An acknowledged call's result
  carries `acknowledged {n, status, amount}` and a `note` that nothing new was sent. The tool's description
  and the system prompt carry the same rule. One call made after a definitive answer is a new request. That
  includes two MCP calls for the same refund sent at once, if the first is answered: the second runs after
  it on the booking's queue.
- **I4, GET is truth, the webhook a hint.** `refundPayment` runs `#refreshNow(id, { lenient: true })` first,
  inside its queued step, and `get_booking` calls the queued `refreshRefunds` (lenient too). Both read every
  `pending` operation by GET before anything is decided, so a refund whose terminal webhook was lost or
  already consumed still settles (R8-1's end state can't stick). A lenient GET that fails skips that
  operation and changes nothing; `get_booking` then returns the stored state. The webhook's refresh stays
  strict: a failed GET answers 500 and PayPal redelivers. The operator page and `/api/state` never call
  PayPal.

Also, regardless of severity:

- **R8-5:** `#reconcileCapture` holds a capture that PayPal already reports `REFUNDED` or
  `PARTIALLY_REFUNDED` on a booking not yet captured. It goes to `needs_review` (`capture.reconcile_failed`,
  problem "the capture was already refunded at PayPal (...) before it was recorded as paid"), with no `paid`
  event. Its only caller, `#captureNow`, returns early once a booking is captured, so every reconcile that
  gets that far is a first one. The `!b.captured` guard keeps a later read of a capture we refunded ourselves
  as it was.
- **R8-6:** the scripted model's `refundReply` (`src/agent/scripted.ts`) says "Done: ... refunded" only for
  a refunded or partially refunded booking. A refund pending at PayPal says it is pending, a booking in
  review says the refund is held for review, and an acknowledged earlier refund says it went through (or is
  pending) and that nothing new was sent. A `refund_unconfirmed` error reads "I couldn't confirm the refund
  yet".
- **The card:** `labels.js` `refundLine` adds "Refund under way: {amount} back to you from {guide}; PayPal
  hasn't confirmed it yet." (`refund-pending`) while `summary().refund_pending` is set, next to "Paid".
  `summary()` adds `refund_review_cause` (`unknown`, `mismatch` or `already_refunded`). `paymentLine` says
  that a refund held only for an unknown outcome "may have gone through" and may still be settled by
  PayPal's notice, not that a reply didn't match.

**Tests** (`test/fix9-*.test.ts`). The red runs were at ba4d6d7: 11fd5fc's service, client, tools, agent and
page code, plus only the fake's new controls (two test-infrastructure commits; the tests can't run without
them). `fix9-outcome` reproduces R8-1 to R8-6 and the card line and pins each invariant. 30 of its first 34
tests failed there; the 4 that passed are guards. A 35th, added after the fix, pins an I3 path the matrix
can't reach (settled pending by its event, then completed with that webhook lost). `fix9-matrix` is the
ordering matrix: a full or
10.00-of-30.00 refund whose first attempt lost its reply, and three things PayPal may have done with it
(completed it at once; created it PENDING, then completed it; created it PENDING, then failed it, at the
moment its webhook is sent). The client's own retry is answered with a replayed 201, a 422
`CAPTURE_FULLY_REFUNDED`, or lost too. Then every arrival order is tried of that reply, the webhook, the
agent's resend and a `get_booking`: 24 orders, or 6 without the resend after a 201, which answered the
call. The retry's reply is held at the fake until its turn, so the others can arrive before it and queue.
It asserts, at every step, at most one unknown operation. At the end it asserts: what PayPal refunded equals
`refunded_minor` plus the amounts held for review (and nothing is held once the refund's own webhook
arrived); PayPal refunded either nothing or the intended amount, with a second operation only after the
first failed; nothing is left pending, sending or held; the status and the waiting move follow the money.
144 of its 324 cases failed at ba4d6d7: R8-2 96, R8-1 24, R8-3 24. A refused resend (R8-4) isn't in the
matrix (the fake replays a repeated request id); its two tests in `fix9-outcome` cover it. The fake gained a refund that is PENDING
and settles later (`pendNextRefund`, `settleRefund`), a 5xx after processing (`dropResponse` with a 5xx),
and a held reply (`wait`, `pass`). **Earlier test whose meaning changed:** `fix8-lostreply`'s first D3 case:
the `refund_payment` after the webhook recorded the lost-reply refund now reports it (`acknowledged`)
instead of being refused, and the call after that is refused as nothing left. `SCHEMA_VERSION` stays 2:
every new field is optional.

**UNVERIFIED** (spike): that PayPal answers a repeated `PayPal-Request-Id` with the first reply (the fake
does, so R8-1's stale PENDING replay is modelled on it); that the refund resource in refund webhooks, and in
`GET /v2/payments/refunds/{id}`, carries the `custom_id` we send (without it, no booking is found and the
event completes unused, so the next `refund_payment` still resends; corrected in §19 F2: only a `sending`
operation is resent, and the booking is now found by the refund's capture); and the names of PayPal's refund
webhooks beyond `PAYMENT.CAPTURE.REFUNDED` (the handler takes any `PAYMENT.REFUND.*`).

## 19. Round 10: no refund evidence is dropped; a refund found by its capture; any settle closes a move (2 Nov)

Round 9's five findings (R9-1 to R9-5) each rest on PayPal behaviour nobody has verified yet. Each fix is small
and fails closed, so the app is right under either premise:

- **R9-1, R9-4 (medium).** Suppose PayPal doesn't dedupe a repeated `PayPal-Request-Id`. Then the client's own
  retry of a refund (or the agent's resend) makes a second refund. The first refund's webhook names the booking,
  but its id was on no operation and no operation's outcome was unknown. So `#resolveUnknownNow` returned, and
  the event was answered 200 with nothing recorded: PayPal had moved 20.00, the booking counted 10.00, and
  nothing was held. In R9-4's second form, a FAILED refund matched by amount freed the unknown operation while a
  COMPLETED duplicate went unrecorded, and the agent's retry then refunded again.
- **R9-2, R9-5 (low).** A refund webhook without `custom_id` found no booking: the capture id was only in its
  links. So a refund held for an unknown outcome never cleared. Also, the hosted webhook isn't subscribed to the
  refund failure events.
- **R9-3 (low).** Only the COMPLETED branch withdrew a waiting move.

Three words are used with one meaning throughout:

- A refund **names** the booking when its `custom_id` is the booking's id. With no `custom_id`, it names the
  booking when its `links[rel=up]` is `/v2/payments/captures/{the booking's capture_id}`. Nothing in it may name
  another booking or capture (`namesBooking`, `namesOther`, `refundCaptureId` in `src/booking/service.ts`).
- It **matches** the booking's one operation whose outcome is unknown when it carries that operation's amount in
  the capture's currency.
- The booking **accounts for** every refund on it that isn't `failed`: completed, pending, being sent, held, and
  unexplained entries (`accountedMinor`, the same sum as `reservedMinor`).

**I5, no refund evidence is dropped silently.** For every refund event (`PAYMENT.CAPTURE.REFUNDED`, any
`PAYMENT.REFUND.*`), `handleWebhook` runs the strict `#refreshNow`, then `#refundEvidenceNow`, which replaces
`#resolveUnknownNow`. If the event's refund is on no operation and names the booking, it is read back by GET. A
GET that names another booking or capture is ignored. Then, on the booking as stored after the GET:

- **It matches the unknown operation.** That operation is settled by `#applyRefund` as in round 9 (I2), whatever
  the status.
- **Otherwise FAILED or CANCELLED: logged only.** If an operation's outcome is unknown, the row is
  `refund.evidence_unmatched`, as before. That is round 9's open question 1, answered: a refund that moved no
  money neither settles nor holds anything, and the unknown operation stays unknown and reserved. If none is
  unknown, the row is `refund.unexplained` with `held: false`.
- **Otherwise (COMPLETED, PENDING or any other status): an evidence entry.** It goes on `refund_ops` with
  `evidence: true`, `status: needs_review`, `review_cause: "unexplained"`, its `refund_id` and its
  `amount_minor`. Its `request_id` "paypal-{id}" is a label; nothing is sent with it. It is logged
  `refund.unexplained` with `held: true`. The entry is reserved and held:
  - `statusFromRefunds` gives `needs_review`;
  - `summary().refund_review` includes its amount, and `refund_review_cause` says `unexplained` (the order is
    mismatch, already_refunded, unexplained, unknown);
  - `#reserveRefund` refuses every new refund and every resend while it is there (`UNDER_REVIEW.unexplained`).
  It never clears automatically: `#refreshNow` reads only pending operations, and the evidence path never weighs
  its refund again, since that id is now on an entry. A person reconciles it.
- **Changed from round 9.** A COMPLETED or PENDING refund of another amount, arriving while an operation is
  unknown, used to turn that operation into a `mismatch` hold. That held the operation's own amount, and its own
  refund was then dropped. Such a refund doesn't match, so it is now its own unexplained entry and the
  operation stays unknown. The operation's own evidence still settles it, and refunded plus held equals what
  PayPal moved.
- **A GET that fails throws.** The webhook answers 500 and PayPal redelivers. So a refund event is answered 200
  only once its evidence is recorded, or found to need nothing.
- **Another refund id.** `#applyRefund` also holds as a mismatch an answer that names a different refund id from
  the one its operation recorded (a GET of a pending refund). The service never applies one otherwise, so this
  check is defensive.
- **Kept by their `webhook.*` row only.** Two refund events change nothing but leave the event's own ledger row.
  One is for a booking never recorded as paid (`captured` unset): for instance one held under R8-5 because PayPal
  already reported its capture refunded, which is in review already. The other is a resource that contradicts
  itself (its `custom_id` is this booking's, but its `up` link names another capture).

**F1, PayPal's total refunded.** This depends on an UNVERIFIED premise: that the refund reply and the GET carry
`seller_payable_breakdown.total_refunded_amount`, and that it is the capture's running total of completed
refunds. Every save of a refund change goes through `#saveRefunds`:

- It keeps the largest total seen in `paypal_refunded_minor`. A total in another currency, or none, changes
  nothing.
- `refundTotalExcess` is that total minus what the booking accounts for, and never less than 0. Above 0 it holds
  the booking: `needs_review`, cause `unexplained`, the excess counted in `refund_review`. It is logged
  `refund.unexplained` with `source: "total_refunded_amount"` when it grows.
- **A deviation from the brief's "completed plus this one".** The comparison uses everything the booking
  accounts for, including operations that are pending, being sent or unknown, since their money may already be
  in PayPal's total. Counting completed refunds only would raise a false hold: when one refund completes while
  another operation's reply was lost, the other's own evidence would then count it twice (`fix10-evidence`,
  "kept: an operation pending or unknown counts as accounted").
- **The excess is derived, not stored as an entry.** So evidence that later names the refund behind it replaces
  it rather than adding to it: the excess falls as entries account for it, and each entry holds the booking
  itself. That is the only way it falls. No operation is reserved while the booking is held, and settling an
  operation never raises what the booking accounts for.
- With the field absent, the check is skipped and I5 alone applies.

**R9-4's second half** is covered once the other refund's evidence holds the booking, in either order
(`fix10-evidence`, "R9-4 (C2)"):

- **FAILED first.** The operation fails (it matches). R2's webhook then holds the booking as unexplained, and the
  agent's retry is refused.
- **COMPLETED first.** R2 settles the operation, and R1's FAILED is logged only.

What remains: R2's evidence never arrives (its webhook is lost, or never sent), and the FAILED came first. The
booking then says captured with 0.00 refunded, while PayPal has refunded 10.00, and the agent's next
`refund_payment` would send a new refund. With `total_refunded_amount` present, the FAILED refund's own GET
already shows R2's 10.00, so the booking is held at that step. Without it, nothing in the service can tell; a
person has to compare with the capture at PayPal. Payments v2 has no call that lists a capture's refunds. A GET
of the capture's status (`PARTIALLY_REFUNDED`) would be a weak hint, and isn't done.

**F2, a refund found by its capture.** When the resource has no `custom_id` and its id is on no booking,
`#findForResource` falls back to the capture named by `links[rel=up]` (`refundCaptureId`). It takes only
`/v2/payments/captures/{id}`, because a capture's own `up` link is its order. `#refundEvidenceNow` uses
`namesBooking` and `namesOther`; the amount and currency checks are unchanged.

This corrects §17 D3 and §18's UNVERIFIED paragraph. "Without custom_id ... the next `refund_payment` still
resends" held only for an operation still `sending`. An operation held for an unknown outcome (after a refused
retry or resend) is never resent, and `get_booking` doesn't read it (it has no refund id), so before round 10
nothing could clear it. Now its refund's webhook settles it by the capture link. It still stays held until a
person reconciles it if PayPal's refund webhooks carry neither `custom_id` nor that link, or if the event never
comes. A failure event the hosted webhook isn't subscribed to yet is one case (DEPLOY.md's new TODO-CHECK for the
refund failure events, whose exact names are DESIGN.md §5 S12's P4, read off the developer dashboard).

The traveller's card no longer promises the notice: "Nothing more is refunded meanwhile: if PayPal's notice
doesn't settle it, a person will reconcile it." The agent-facing `refund_under_review` texts say the same. An
unexplained hold has its own line: "A refund needs review: PayPal reports {held} refunded on this booking that
no refund this booking sent accounts for, so more may have come back to you than it shows. Nothing more is
refunded until a person reconciles it." Before, it fell into the "didn't match what was sent" line, but nothing
had been sent.

**F3, any settle closes a waiting move.** Every branch of `#applyRefund` (completed, pending, failed, mismatch),
and the evidence entry, saves through `#saveRefunds`. It derives the status from the refunds. When that status
is `refunded` or `partially_refunded` and a move is still `proposed`, it withdraws the move in the same save and
logs `reschedule.withdrawn` after the branch's own rows. No other path sets those statuses. A hold in that same
save keeps the move, as in §16. A move that an earlier settle withdrew stays withdrawn when a later hold comes.

**Tests** (`test/fix10-*.test.ts`). The red runs were at 8ea717f: 95f8312's service, plus only the fake's new
controls (8573cad: `dedupe`, `refundCustomId`, `refundTotals`, `replyAfter`). Three files:

- **`fix10-evidence`** reproduces R9-1 to R9-5 and pins I5, F1, F2 and F3. 23 of its 27 tests failed at
  8ea717f; the 4 that passed are guards. One red test was later replaced, so it still has 27. That test assumed
  an operation's resend could be answered with a refund already held as unexplained. It can't: the hold refuses
  the resend first. So it became a test of that refusal.
- **`fix10-matrix-nocustom`** is round 9's 324 cases with refund resources that carry no `custom_id`. It ends as
  round 9 does: the refund's own webhook arrived, so nothing is held. 258 of 324 failed.
- **`fix10-matrix-nodedupe`** has 504 cases in which PayPal doesn't dedupe a repeated request id. Attempt 1
  makes R1 and loses its reply. PayPal completes R1, or makes it PENDING and then completes or fails it. The
  client's retry reaches PayPal at once: it makes R2 for 10.00 of 30.00, or for the whole deposit it is refused
  422 (nothing is left). Its reply is answered or lost when R arrives. Then come every arrival order of the
  retry's reply, R1's webhook, R2's webhook and the agent's resend (no resend after a 201), and then every other
  refund webhook PayPal sent (a resend's R3). Each of those runs with `custom_id` on and off, and with
  `total_refunded_amount` on and off. 404 of 504 failed. There is no `get_booking` signal: no operation is ever
  pending in this grid (R2 and R3 complete at once), so it reads nothing.
- **Both matrices assert at the end:**
  - the money truth: PayPal's completed refunds equal `refunded_minor` plus every amount held for review;
  - every refund PayPal completed is on the booking exactly once;
  - nothing is left pending, sending or unknown;
  - at most one unknown operation at every step.
  The nodedupe grid also asserts:
  - at most 3 refund POSTs;
  - held money means `needs_review`, and otherwise the status and the move follow the money.
- **Green, step by step.**
  - df4179f (F2): nocustom 0 failing, nodedupe 304, evidence 20.
  - 0ad60f8 (F3): evidence 18.
  - c1956e4 (I5, F1): nodedupe 0, evidence 4.
  - 134ae9c (the texts): evidence 1.
  - This section's commit, with DEPLOY.md: 0.

**Earlier tests whose meaning changed** (all through I5's "matches"):

- `fix9-outcome` R8-4, "an event of another amount". It used to turn the unknown hold into a mismatch. Now the
  5.00 is held as unexplained beside it, and the unknown refund's own event completes it, with the booking still
  in review.
- `fix9-outcome` I1, `already_refunded` (both issues). The out-of-band 30.00 is now recorded beside the hold.
- `fix8-lostreply` D3, "fails closed: a refund event whose amount isn't the operation's". The 5.00 is its own
  unexplained entry, and the operation stays `sending`.

`SCHEMA_VERSION` stays 2: `evidence` and `paypal_refunded_minor` are optional, and `unexplained` is one more value
of an optional field.

**Verify in spike S11** (each one the code now depends on, and what happens if it is false):

- **Dedupe.** That PayPal answers a repeated `PayPal-Request-Id` on `POST /v2/payments/captures/{id}/refund` with
  the first reply. If it doesn't, I5 and F1 catch the extra refund and hold the booking. This is the only
  premise that decides whether one intent can cost two refunds.
- **`custom_id`.** That the refund resource in refund webhooks, and in `GET /v2/payments/refunds/{id}`, carries
  the `custom_id` we send. If it doesn't, F2's capture link is the fallback.
- **The `up` link.** That the same resources carry `links[rel=up]` to `/v2/payments/captures/{id}`. If neither
  this nor `custom_id` is there, a refund with no known id finds no booking, an unknown hold waits for a person,
  and I5 can't see a duplicate.
- **The resource.** That `PAYMENT.CAPTURE.REFUNDED`'s resource is the refund (its id is a refund id), as the
  fake assumes.
- **The failure events.** The exact names of PayPal's refund failure events (`PAYMENT.REFUND.FAILED`?
  `PAYMENT.REFUND.CANCELLED`?), to subscribe to (DEPLOY.md's TODO-CHECK).
- **The total.** That `seller_payable_breakdown.total_refunded_amount` is present on the refund reply and on GET,
  in the capture's currency. Also whether it counts only completed refunds or pending ones too. Pending counted
  only over-holds, which fails closed. And whether a GET shows the running total or the total when that refund
  was made. A stale total only under-detects, and I5 still applies.
- **PENDING then FAILED.** That a sandbox refund can be PENDING and later FAILED or CANCELLED. That is the path
  R9-3 and R9-4 (C2) rest on.
- **The refusal issues.** Which 422 issue PayPal answers a refused retry or resend with (`CAPTURE_FULLY_REFUNDED`,
  `REFUND_AMOUNT_EXCEEDED`?). Either way, round 9's I1 holds it.

## 20. After round 10: a reversal is refund evidence; the resend texts promise no dedupe (2 Nov)

Round 10's two re-attacks closed R9-1..R9-4 and the code half of R9-5 (its other half, the refund failure event
names, is DEPLOY.md's TODO-CHECK for §5 S12's P4). They found two more, both resting on unverified PayPal
behaviour; the CTO fixed them inline (tests first: `test/fix11-reversed.test.ts`, 3 of 4 red at 1460608).

- **A reversal's refund was dropped (medium, not reachable on the demo: a reversal needs a dispute).**
  `PAYMENT.CAPTURE.REVERSED` is subscribed, and PayPal's event-names page lists a refund as its resource, but
  the handler counted only `PAYMENT.CAPTURE.REFUNDED` and `PAYMENT.REFUND.*` as refund events. A reversal went
  to the capture refresh, which returns for a captured booking: 200, nothing weighed, the card still "Paid" and
  the move still answerable ("the deposit carries over"). Now any event whose `resource_type` is `refund` is a
  refund event, so the reversal's refund, which no operation accounts for, holds the booking as `unexplained`
  (I5), found by `custom_id` or by its capture link. A `REVERSED` whose resource is a capture still goes to the
  capture refresh (the test keeps it).
- **The resend texts over-promised (low).** `refund_unconfirmed`, `refund_payment`'s description and the system
  prompt said a resend "never refunds twice". Without dedupe a resend can make a second refund; I5/F1 then hold
  the booking, but only after the money moved. The three texts now say the resend carries the same
  PayPal-Request-Id so PayPal can recognise it, and that a second refund PayPal reports anyway holds the booking
  for review with nothing more sent. `test/fix9-outcome.test.ts`'s two wording checks changed with them.

**Verify in spike S11** gains one line: **the reversal's resource**, i.e. that `PAYMENT.CAPTURE.REVERSED` carries
`resource_type: refund` and a refund resource (if it carries the capture instead, a reversal still goes
unnoticed until a person looks).

Kept as decided by the round-10 builder: PayPal's running total is compared with every refund that isn't failed
(completed, pending, being sent or unknown), not with completed ones only, so a lost reply's own refund is never
counted twice.
