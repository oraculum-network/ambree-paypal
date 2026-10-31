# Notices

Ambree "Book the guide" is MIT-licensed (see `LICENSE`). All of its code was written for the PayPal AI
Hackathon during the submission period (from 31 Oct 2026). Nothing is copied from the private Ambree app;
the mandate, ledger, operator page and cyclone ideas are rewritten from scratch here.

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
Payee addresses use the reserved-style domain `business.sandbox.example`. Cyclone warnings in the demo come
from the demo feed (`src/weather/cyclones.ts`), never from a real agency.

## Brand

The Ambree name belongs to the Ambree authors. The MIT licence covers the code, not the brand.
