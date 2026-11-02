# Notices

Ambree "Book the guide" is MIT-licensed (see `LICENSE`). All of its code was written for the PayPal AI
Hackathon during the submission period (from 31 Oct 2026). The mandate, ledger, operator page and cyclone
ideas came from our own earlier design notes for Ambree; no code was copied, and all of it is written from
scratch here.

## Dependencies

`@modelcontextprotocol/sdk` (MIT) and `zod` (MIT) at runtime; TypeScript (Apache-2.0), vitest (MIT) and
Playwright (Apache-2.0) for development. Storage is Node's built-in `node:sqlite`.

## PayPal

This project uses PayPal's REST APIs (Orders v2, Payments v2 refunds, Webhooks v1) in the **sandbox only**.
It is **not affiliated with or endorsed by PayPal**. It uses no PayPal logo; "PayPal" appears in text only.
`src/paypal/fake.ts` is an original stand-in written from PayPal's public API reference, for tests and the
offline demo; it contains no PayPal code or response data.

`@paypal/agent-toolkit` (Apache-2.0) is not bundled; `src/paypal/api.ts` says where it would plug in.

## Demo data

Every guide in `src/guides/seed.ts` is invented and named "… (demo)"; none is a real business or person.
Guides carry invented PayPal merchant ids only, never email addresses. On the hosted sandbox, one sandbox
business account plays every guide. The fake's stand-in buyer uses the reserved-style domain
`personal.sandbox.example`. Cyclone warnings in the demo come from the demo feed (`src/weather/cyclones.ts`)
or from the page's per-booking simulation, which is labelled "simulated". They never come from a real agency.

## Brand

The Ambree name belongs to the Ambree authors. The MIT licence covers the code, not the brand.
