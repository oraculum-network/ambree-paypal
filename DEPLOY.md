# Deploy plan: paypal.ambree.ai on oraculum-prod (draft for the CTO)

The pattern is qloo.ambree.ai's:
- the image is built on the host, never on a laptop;
- k3s runs it with `imagePullPolicy: Never`;
- Traefik routes the host and gets its Let's Encrypt certificate;
- it gets its own namespace, `paypal`.

The CTO writes and runs the infra. This file lists what the repo provides and what to check. Every
`TODO-CHECK` is unverified from here.

| File | What it is |
|---|---|
| `Dockerfile`, `.dockerignore` | node:22-alpine (the same digest as qloo), `npm ci --omit=dev --ignore-scripts`, runs as `node`, read-only root filesystem, sqlite on `/data` |
| `deploy/k8s/` | Deployment, Service and Ingress `paypal-web` for `paypal.ambree.ai`, namespace `paypal`, image `oraculum/ambree-paypal` |
| `scripts/spike.ts` | The sandbox check (third-party payee, capture, refund); it can also run in the pod |

**Safe default.** Every env var comes from the Secrets `paypal-sandbox` and `llm`, all with `optional: true`.
With no Secret, the pod runs the fake PayPal and the scripted model, which the page labels. With
`PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` set but no `PAYPAL_GUIDE_PAYEE_EMAIL`, the app **refuses to
start**: this fails closed, so it never pays the app owner by mistake.

## Checks before the first deploy

- TODO-CHECK: the deploy gate admits the image `oraculum/ambree-paypal:<sha7>` and the namespace `paypal`
  (`SERVICES` and `APP_NAMESPACES` in the monorepo's `ops/oracle/remote/deploy-gate.sh`, as was done for qloo).
- TODO-CHECK: `INGRESS_HOST_RE` admits `paypal.ambree.ai`. It admitted any `*.ambree.ai` for qloo.
- TODO-CHECK: the namespace block in `ops/oracle/security.sh`, a copy of qloo's:
  - PSA restricted;
  - PriorityClass `paypal-low`;
  - quota and limits;
  - NetworkPolicies selecting `app.kubernetes.io/name: ambree-paypal`: in from Traefik on :8080, out to DNS,
    out to TCP 443 public (`api-m.sandbox.paypal.com` and the LLM host can't be named in a NetworkPolicy).
- TODO-CHECK: a PVC for `/data`. The ledger and bookings must survive restarts until judging ends on 15 Dec.
  The draft uses `emptyDir`; swap it for a `local-path` PVC if the host has that provisioner.
  `strategy: Recreate` and one replica are deliberate: one sqlite writer.
- TODO-CHECK: the base image's Node is at least 22.18 and has `node:sqlite` without a flag (Node 22.13 or
  later does; it prints an ExperimentalWarning, which `NODE_NO_WARNINGS=1` silences).
- TODO-CHECK: the A record `paypal.ambree.ai → 130.61.238.6` (Cloudflare, DNS-only) resolves publicly
  **before** the first Ingress apply.

## Secrets (values typed by hand, never in git or chat)

- `paypal/paypal-sandbox`: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`,
  `PAYPAL_GUIDE_PAYEE_EMAIL` (the sandbox business account that plays every guide).
  - Also `PAYPAL_OPERATOR_EMAIL` and `PAYPAL_OPERATOR_MERCHANT_ID`: the REST app owner's own sandbox
    account. At least one is required. Set both, because an email can't be matched against a merchant id.
  - Optionally `MCP_DEMO_PASSCODE`; without it, `/mcp` answers 401.
  - TODO-CHECK: the operator's merchant id, from the sandbox account's profile.
- `paypal/llm`: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (OpenRouter with a spend cap until 15 Dec;
  TODO-CHECK the cap).

## PayPal sandbox setup (CEO, Mon 2 Nov)

1. Create a sandbox REST app. Its client id and secret go into the Secret above.
2. Create the sandbox accounts:
   - 1 personal account, the traveller (its login goes in the README for judges);
   - 1 business account, every guide;
   - optionally a second business account for the spike.
3. Run the spike from a laptop with the env set, and paste the table into the CTO's notes:
   `node scripts/spike.ts --payee-email <guide business sandbox email>`. Do it again with `--with-payment-source`.
4. After the first deploy, add a webhook in the sandbox app:
   - URL: `https://paypal.ambree.ai/webhooks/paypal`.
   - Events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`,
     `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REVERSED`.
   - Put its id in `PAYPAL_WEBHOOK_ID` and restart the pod.
   - Without the id, the endpoint answers 503 (PayPal retries), and capture still happens on the return URL.
5. TODO-CHECK: one `POST /v1/notifications/simulate-event`, or a real checkout, shows a `webhook.*` row in
   the ledger.

## After deploy

- `curl https://paypal.ambree.ai/healthz` → `{"ok":true,"paypal":"sandbox","model":"openai"}`.
- Run the README's judge steps once with the sandbox buyer.
- TODO-CHECK: uptime monitoring (qloo has none to copy).
- TODO-CHECK: rate limits. This app has body-size limits but no per-IP limiter yet. With a live LLM key,
  every chat turn costs money, so a limiter (as in qloo's `src/http/rate-limit.ts`) belongs here before the
  submission.
