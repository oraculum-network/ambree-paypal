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
         captured{currency_code,value}?, refunded_minor, reschedule?{new_date,status}, refund_offered,
         created_at, updated_at)                                                                         -- records table, JSON
mandates(id, booking_id, amount{currency_code,value}, payee, quote_hash, nonce, expires_at,
         step_up_hash, attempts, status: proposed|approved|used|expired|locked)                          -- records table, JSON
ledger(seq INTEGER PRIMARY KEY, at, booking_id, kind, data JSON, prev_hash, hash)                        -- append-only
webhook_events(event_id PRIMARY KEY, event_type, received_at)                                            -- dedupe
```

- **Booking status:** `requested → priced → mandate_proposed → mandate_approved → order_created → (capture_pending →) captured → (refunded | partially_refunded)`.
  A definitive create failure goes back to `priced`. `needs_review` (the order or capture doesn't match
  the mandate) and `capture_failed` stop the money steps.
  `declined` (the guide said no) and `cancelled` are terminal. A reschedule keeps the status and changes `date`.
- **Reschedule:** `proposed → accepted | declined`, or `withdrawn` when a full refund completes before the
  guide answered (§15). It can be answered only while the booking is `captured` and no refund has started.
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
only on network errors or 5xx, and only for calls that carry a `PayPal-Request-Id`.

## 5. Unknown until the spike (Mon 2 Nov)

| Id | Question | How the spike answers it |
|---|---|---|
| S1 | Does a sandbox REST app's token work for orders with a **third-party payee** (`email_address` of another sandbox business account)? | (b) the create reply's status and payee echo |
| S2 | Can the API caller (the app owner, not the payee) **capture** that order? | (d) |
| S3 | Does `merchant_id` work as well as `email_address`? | run with `--payee-merchant-id` |
| S4 | Can the API caller **refund** a capture whose payee is another account, without `PayPal-Auth-Assertion`? | (e). If not, the fallbacks are (i) the guide refunds from their own PayPal (the operator page then says how) or (ii) the report's fallback, an invoice from the guide's own app |
| S5 | Which approve link comes back with `payment_source.paypal.experience_context`: `approve` or `payer-action`? | the printed links |
| S6 | The capture reply shape, and whether `custom_id` is echoed on the capture | the printed ids |
| S7 | The exact webhook payloads and headers; `verification_status` values | after deploy: a sandbox webhook to `paypal.ambree.ai`, plus `simulate-event` |
| S8 | Does a personal sandbox account work as payee (concept A's question)? Not needed for B | optional run |
| S9 | Currency: EUR versus USD for an MU business sandbox account | run once with each |
| S10 | JS SDK v6 buttons versus the redirect approve link for a third-party payee | not in the spike; the build uses the approve link (redirect) first |
| S11 | Does `GET /v1/identity/openidconnect/userinfo?schema=openid`, called with the **app's client-credentials token**, describe the REST app's owner, and is its `payer_id` the owner's merchant id (equal to the id in the sandbox dashboard)? If not, which documented call returns the app owner's merchant id? | row "a2 identity": prints payer_id, user_id, account_type and the field names (never a token). Compare payer_id with the dashboard's merchant id |

## 6. The agent's tools (one registry: `src/tools/`; served to the model and over MCP)

| Tool | Input | Effect | Money? |
|---|---|---|---|
| `search_guides` | `area?`, `activity?`, `date?`, `language?` | Lists seed guides that match | no |
| `request_quote` | `guide_id`, `date`, `party_size`, `activity`, `note?` | Creates a booking and an operator link; the guide is "notified" | no |
| `get_booking` | `booking_id` | Status, quote, mandate state, order and capture ids, refunds | no |
| `propose_mandate` | `booking_id` | Builds the mandate from the frozen quote; the step-up code goes to the traveller channel only | no |
| `create_order` | `booking_id` | **Only** with an approved, unexpired, unused mandate whose quote hash, amount and payee match. Creates the order with payee = the guide; returns the approve link | prepares a payment |
| `get_order` | `booking_id` | `GET /v2/checkout/orders/{id}` | no |
| `capture_order` | `booking_id` | Idempotent capture, only once the order is APPROVED | yes (traveller → guide) |
| `check_weather` | `booking_id` | Cyclone alerts for the booking date and a plain explanation | no |
| `propose_reschedule` | `booking_id`, `new_date` | Asks the guide on the operator page | no |
| `refund_payment` | `booking_id`, `amount?` | Only when the policy (§2.2) allows; partial or full | yes (guide → traveller) |

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
| `GET /o/{token}`, `POST /o/{token}` | The operator page: price, accept or decline a reschedule, offer a refund. The token is 256-bit base64url and stored as sha256; there is no login |
| `GET /paypal/return`, `GET /paypal/cancel` | The PayPal redirects, both to `/` (never a conversation id). Return captures if the session owns the booking |
| `POST /webhooks/paypal` | Verify via call 7, log to the ledger once, process. Only completed processing makes a redelivery a duplicate; a processing failure answers 500 |
| `POST /mcp` | The tools over MCP (stateless). Off unless `MCP_DEMO_PASSCODE` is set (Bearer); scoped to the conversation `mcp` |
| `GET /fake-paypal/checkout?token=` | **Fake mode only**: a stand-in buyer approval page |
| `POST /api/demo/cyclone` | Fake and sandbox mode (live is refused at startup). Needs an existing session (401, and it never creates one). **Sandbox:** `{booking_id}` of a booking the session owns (else 404) and has paid (`captured`; else 409 with the reason, and nothing is saved); posts one simulated warning for that booking's day, once, and calls no payment API (§14). **Fake:** unchanged, a demo-feed alert around every booking of the tab's conversation |
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
- **Refund events.** `PAYMENT.CAPTURE.REFUNDED` and any `PAYMENT.REFUND.*` (e.g. `PAYMENT.REFUND.FAILED`;
  the exact names are **UNVERIFIED**) call `refreshRefunds`. A terminal status other than COMPLETED/PENDING
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
  - It is idempotent and runs one at a time with the booking's money steps (`#serial`): a second call (or a
    racing one) answers `posted: false` with no new row or event, and a press while a capture or refund is
    waiting on PayPal waits for it.
  - Only a paid (`captured`) booking takes it; the agent can only move a captured booking, so a warning spent
    earlier could never lead to the reschedule. Any other status answers 409 and records nothing (no
    `simulated_alert`, no ledger row, no event), with one message per group:
    - not paid yet (requested, priced, mandate_proposed, mandate_approved, order_created; reason `not_paid`):
      "pay for the booking first, then simulate";
    - finished or still in processing (declined, capture_pending, capture_failed, needs_review,
      partially_refunded, refunded; reason `cannot_simulate`): it can't be simulated now, and why.
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
    tab's newest booking (sandbox: enabled only when that booking is captured, with the reason shown
    otherwise; `simulateControl`), and "Start over", which adds a new conversation to the caller's own
    session and switches this tab to it.
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
  sent). `refundReason(b)` keeps its contract (`check_weather`'s `refund_allowed`).
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
  (`labels.js` `rescheduleLine`). A partial refund leaves the move `proposed`. The status is additive and the
  field optional, so `SCHEMA_VERSION` stays 2.
- **Fake mode:** unchanged in behaviour. Its demo-feed raise is a feed warning (rule (a)); R1–R4 apply in
  every mode, and its e2e refund path declines the move before the refund, so nothing is withdrawn there.
