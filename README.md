# Ambree: book the guide, pay the guide

**An AI travel concierge that books a small independent guide in Mauritius, then has you pay the guide's
deposit straight into the guide's own PayPal account.** It does this only inside a mandate you approved.
Ambree never holds your money. PayPal sandbox only.

> "Find me a hiking guide for Le Morne on Thursday and hold the spot."

1. **Ambree finds a guide** and asks for a price. The guide gets a private link (`/o/{token}`) and replies
   from their phone: a total, a deposit and a note. No app or account is needed.
2. **Ambree proposes a mandate:** the amount, the payee (the guide's PayPal), a hash of the quote, a
   15-minute expiry and a one-time nonce. You approve it with a 6-digit step-up code sent to *you*. The AI
   agent never sees that code and has no tool to approve a mandate.
3. **Only then can the agent create a PayPal Orders v2 order.** Its `purchase_units[0].payee` is the guide's
   own account, so the money goes traveller → guide.
4. **You approve in PayPal checkout.** Ambree captures the payment, and PayPal's webhooks (signature checked
   with PayPal) are logged to a **hash-chained ledger** you can verify on the page. The chain catches an
   edited, inserted or reordered row. A deleted tail or a rolled-back file is caught only against the head
   kept outside the database (`GET /api/ledger/head`, also logged on every append).
5. **If a cyclone warning covers the day,** Ambree explains the risk and asks the guide to move the trip. If
   the guide can't, it refunds the deposit from the guide's capture back to you.

- **Licence:** MIT (`LICENSE`); third-party notices are in `NOTICE.md`.
- **Design:** `DESIGN.md` has the flows, the data model, every PayPal call with its doc link, and the open
  questions.
- **Site:** https://paypal.ambree.ai (planned; see `DEPLOY.md`).

## Why PayPal and AI are both essential

- **PayPal is the money layer and the trust layer.**
  - Orders v2 with a third-party `payee` lets a micro-supplier with nothing but a PayPal account get paid
    by a stranger, with no marketplace in between holding funds.
  - Refunds go back the same way.
  - Verified webhooks (`/v1/notifications/verify-webhook-signature`) are the source of truth the ledger
    records.
  - Without PayPal the agent could only say "send them money somehow".
- **AI is what makes it a booking rather than a form.**
  - The agent works out what was asked (place, activity, day, party).
  - It picks a guide, runs a back-and-forth with the guide, reads the guide's price, and assembles the
    mandate.
  - It reacts to events (the guide answered, you approved, you paid, a cyclone warning) and explains the
    weather risk.
- **The rules are code, not prompt.**
  - The booking service (`src/booking/service.ts`) creates an order only by consuming an approved, unexpired,
    unused mandate whose amount, payee and quote hash still match. If PayPal refuses the create, the mandate
    is spent and the traveller approves a new one. If the create gets no clear answer (timeout, 5xx), it is
    retried with the same nonce (PayPal-Request-Id) only while the mandate is still valid.
  - Before capturing, it re-reads the order from PayPal. The order must have exactly one purchase unit with the
    mandate's payee, amount and currency, and must reference the booking. After capture, the capture's amount
    must match too. Otherwise the booking goes to `needs_review` and is not marked paid.
  - "Paid" and "refunded" mean PayPal said `COMPLETED`. The page shows "Payment pending", "Payment failed"
    or "Payment needs review" otherwise.
  - It refunds only when there is a cyclone warning, a declined reschedule or the guide's offer. Each refund
    is saved (amount and PayPal-Request-Id) before it is sent, and retried unchanged.
  - PayPal's refund reply must carry exactly that currency and amount. A missing or different amount puts
    the booking in `needs_review`: nothing is counted as refunded and no success is announced.
  - A refund that ends `FAILED` or `CANCELLED` (seen by GET after a `PAYMENT.REFUND.*` or
    `PAYMENT.CAPTURE.REFUNDED` webhook) releases its reserved amount.
- **Traveller authority is a session, not an id.**
  - Each browser gets an HttpOnly, SameSite=Lax session cookie (Secure on https).
  - Each tab names its own conversation on every request, and the server checks that the session owns it.
    Reading state, approving a mandate and every tool call work only on the caller's own bookings.
  - Every state-changing `/api/*` POST needs `Content-Type: application/json`. If the request carries an
    `Origin`, it must be the configured public origin. The guide's page and the fake checkout check the
    Origin too.
  - These checks run before any session is looked up, so a cross-site request can't create or replace a
    session.
  - The demo control "Simulate a cyclone warning (demo)" (`POST /api/demo/cyclone`) also needs an existing
    session (401 otherwise). On the hosted sandbox it acts only on a booking the session owns (404
    otherwise), once, and calls no payment API.
  - MCP is off unless `MCP_DEMO_PASSCODE` is set. MCP calls run in their own scope and can't see web
    bookings.

**Never custody, and exactly what is enforced.** The guide's account receives the deposit, and refunds
come out of the guide's capture. Accounts are identified by **PayPal merchant id only**, because one account
can have several email addresses (aliases), so an email can't prove two payees are different accounts. In
sandbox mode:
- **Configuration:** `PAYPAL_OPERATOR_MERCHANT_ID` (the REST app owner's account) and
  `PAYPAL_GUIDE_PAYEE_MERCHANT_ID` are required, and the `*_EMAIL` variables are refused.
- **At startup,** the app refuses to start if any guide's merchant id equals the operator's.
- **Orders are sent with `payee.merchant_id`,** never an email. When creating an order, the app refuses an
  operator payee.
- **Before capture,** it re-reads the order and compares its `payee.merchant_id` with the guide's. It
  refuses one that is the operator's, and one that has no merchant id.

**Confirming the operator with PayPal.** Before serving, the app asks PayPal which merchant owns the REST
app. It calls `GET /v1/identity/openidconnect/userinfo` with the app's own token and refuses to start unless
the reply's `payer_id` equals `PAYPAL_OPERATOR_MERCHANT_ID` and matches no guide. It also refuses if the call
fails or carries no `payer_id`.
- **The limit:** PayPal's docs don't say that this call accepts an app (client-credentials) token or that it
  describes the app owner. Its documented sample has no `payer_id`, and the token reply carries only an
  `app_id`.
- **So it is UNVERIFIED (DESIGN.md §5 S11),** and `node scripts/spike.ts` prints what PayPal returns.
- **Opt-out:** if the call can't confirm the owner, `PAYPAL_OPERATOR_IDENTITY=config-only` lets the app run
  on the configured id. `/healthz` then says `operator_identity: "config-only (unconfirmed)"` and the log
  warns. Otherwise it says `"confirmed"`.

Also **UNVERIFIED:** that PayPal's order replies echo `payee.merchant_id`. If they don't, every capture is
refused (it fails closed); the spike checks this (DESIGN.md §5 S6).

A refund whose PayPal reply doesn't match what was sent puts the booking in `needs_review`, and it stays
there even if a later refund completes. While any refund is in review, new refunds and retries on that
booking are refused (`refund_under_review`).

## Run it locally (no keys needed)

Node 22.18 or later (it runs TypeScript directly and uses the built-in `node:sqlite`).

```bash
npm ci
npm start
```

Open http://localhost:8080 and try the whole flow offline:

- **The fake PayPal** (`src/paypal/fake.ts`) speaks the same JSON as the sandbox for OAuth, Orders v2,
  refunds and webhook verification. It even sends webhooks to the app's own endpoint over HTTP.
- **The scripted model** makes deterministic tool calls, so you don't need an LLM key.
- **The page says which of the two is running.** Use the "Guide's phone" panel to answer as the guide, take
  the step-up code from "Your inbox", and use "Simulate a cyclone warning (demo)" to try the refund path.

### With the PayPal sandbox and a real model

Credentials are read from the environment by name and never logged. The code refuses any PayPal base URL
other than `https://api-m.sandbox.paypal.com`.

| Variable | What |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | The sandbox REST app (developer.paypal.com → Apps & Credentials → Sandbox) |
| `PAYPAL_WEBHOOK_ID` | The id of the sandbox webhook pointing at `{PUBLIC_URL}/webhooks/paypal` |
| `PAYPAL_GUIDE_PAYEE_MERCHANT_ID` | The merchant id of the sandbox **business** account that plays every guide (emails are refused) |
| `PUBLIC_URL` | Where PayPal sends the buyer back to (`/paypal/return`) |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Any OpenAI-compatible `/chat/completions` endpoint with tool calling |
| `PAYPAL_OPERATOR_MERCHANT_ID` | The REST app owner's own merchant id, which must never be a payee (required in sandbox mode) |
| `MCP_DEMO_PASSCODE` | Turns on `POST /mcp`; clients send it as `Authorization: Bearer …` |
| `DB_PATH` | The sqlite file for bookings and the ledger (default `:memory:`). It carries a schema version, and a file of any other version is refused (no migrations yet) |

### Check PayPal itself: the spike

`scripts/spike.ts` runs one real sandbox order whose payee is another sandbox account: token, create, your
approval in a browser, capture, full refund. It prints a table of HTTP statuses and ids, and never a token or
secret.

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/spike.ts --payee-merchant-id GUIDEMERCHANT1
```

## For judges

1. Open https://paypal.ambree.ai (or run it locally as above).
2. Type: *Find me a hiking guide for Le Morne on Thursday and hold the spot.*
3. In **Guide's phone**, open the link and set a total of 80 and a deposit of 30.
4. Back on the page, take the code from **Your inbox** and approve the mandate.
5. Press **Pay the guide in PayPal**. On the hosted sandbox, log in as the sandbox buyer:
   `TODO-CHECK: buyer email / password, published here by the CEO` (the rules ask for sandbox login details).
6. Watch the ledger fill in (order, capture, verified webhooks) and the chain say **Chain OK**.
7. Under **Demo controls**, press **Simulate a cyclone warning (demo)**. A real cyclone warning can't be
   triggered on demand, so this puts a simulated warning on your own newest booking's day, once. It is
   labelled as simulated on the page, in the chat and in the ledger (`weather.simulated_alert`). No weather
   service is called and the button itself moves no money. Ambree explains the risk and asks the guide to move
   the trip. On the guide's link, answer "No, I can't": Ambree refunds the deposit from the guide's sandbox
   capture back to you, and the refund webhook appears in the ledger. **Start over** opens a fresh conversation
   in your tab only.

## The agent's tools (also over MCP at `POST /mcp`, with `MCP_DEMO_PASSCODE`)

`search_guides`, `request_quote`, `get_booking`, `propose_mandate`, `create_order`, `get_order`,
`capture_order`, `check_weather`, `propose_reschedule` and `refund_payment`. No tool approves a mandate.
`src/paypal/api.ts` is the one payments interface: the PayPal Agent Toolkit (`@paypal/agent-toolkit`) can
plug in there as another adapter, behind the same mandate check.

## Tests

```bash
npm run typecheck
npx vitest run
npx playwright test
```

- **vitest** covers:
  - every PayPal call and error path against the fake: token caching and refresh, idempotency, timeouts,
    retries, the live-URL refusal, and errors that never carry credentials;
  - the spike;
  - mandates: expiry, a single-use nonce, a lock after 5 wrong codes, and pinning of the payee, amount and
    quote;
  - ledger tampering: edits and deletes in the middle and recomputed hashes, which the chain alone catches;
    a deleted tail, which only the checkpoint catches;
  - the operator page, webhooks (unsigned, tampered, duplicate, and redelivered after a failed processing),
    the refund policy, MCP, and the whole flow over HTTP;
  - the review fixes (`test/fix-*.test.ts`):
    - one session can't read, approve or order on another's booking;
    - payees that are the operator;
    - an order changed after creation;
    - a create failure versus expiry;
    - pending captures and refunds;
    - refund retries;
    - webhook redelivery;
    - log redaction;
    - the ledger checkpoint;
    - spike run ids.
  - the hosted demo (`test/fix4-hosted.test.ts`), in sandbox mode with no network: the cyclone simulation on
    the caller's own booking only, once, with no PayPal call; the page's Demo controls; Start over staying in
    the caller's session.
- **Playwright** runs the happy path and the refund path in a browser against the fake. A second project
  (`sandbox-like`) runs the hosted sandbox-mode path, with the fake behind the REST client and a stand-in
  buyer checkout: the Demo controls, the simulated warning, the refund and Start over.

## Built during the hackathon

All of this repository was written from 31 Oct 2026, inside the PayPal AI Hackathon's submission period.

- **The ideas** (a step-up mandate with a nonce and a quote hash, a hash-chained ledger, a tokenised operator
  page, cyclone awareness) came from our own earlier design notes for Ambree. **No code was copied:** all of it
  is new.
- **Before the hackathon** there was Ambree's concierge product and its design notes.
- **During the hackathon** came the whole of this repository: the PayPal tier, the fake, the spike, the
  mandate and ledger, the guides, the agent, MCP, the pages and the tests.

## Limits, said plainly

- **Sandbox only, made-up guides.** A real version would raise a regulatory question we have not settled:
  booking for someone may count as tour-operator work even without holding money.
- **Conversations live in memory**; bookings and the ledger live in sqlite.
- **The real GDACS cyclone feed is not wired yet.** The "Simulate a cyclone warning (demo)" control stands in
  for it, labelled as simulated. On the hosted sandbox it marks only your own booking's day.
