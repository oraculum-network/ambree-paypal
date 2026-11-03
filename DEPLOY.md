# Deploy plan: paypal.ambree.ai on oraculum-prod

The pattern is qloo.ambree.ai's:
- the image is built on the host, never on a laptop;
- k3s runs it with `imagePullPolicy: Never`;
- Traefik routes the host and gets its Let's Encrypt certificate;
- it gets its own namespace, `paypal`.

This repo is not in the monorepo, so the monorepo's `ops/oracle/deploy.sh` can't deploy it (it archives only its own
repo). The steps below send the same deploy-gate requests by hand. The CTO's
`cw-out/2026-10-31/paypal-app-host/deploy-paypal.sh` scripts steps 1, 4, 5 and 6 and checks 2 and 3 (read-only); it
never creates or changes the Secret. Every `TODO-CHECK` line is unverified from here.

| File | What it is |
|---|---|
| `Dockerfile`, `.dockerignore` | node:22-alpine (the same digest as qloo), `npm ci --omit=dev --ignore-scripts`, runs as `node`, read-only root filesystem, sqlite on `/data` |
| `deploy/k8s/` | Deployment, Service and Ingress `paypal-web` for `paypal.ambree.ai`, namespace `paypal`, image `oraculum/ambree-paypal` (`kubectl kustomize deploy/k8s` renders 3 objects: no Secret, no PVC) |
| `scripts/spike.ts` | The sandbox check (third-party payee, capture, refund); it can also run in the pod |

**It fails closed, never open.** The app refuses any live PayPal URL. With `PAYPAL_OPERATOR_IDENTITY` unset (the
default, `paypal`) it asks PayPal at startup which merchant owns the REST app, and refuses to start unless that is
`PAYPAL_OPERATOR_MERCHANT_ID` and no guide's payee. Every Secret key is required, so with no Secret `paypal-secrets`
(or a missing key) the pod stays at `CreateContainerConfigError`. Empty merchant ids or an empty `LLM_MODEL` make it
refuse to start. So a pod that won't start after step 3 is a config or Secret problem, not an infra one: its log
names the variable (never the value). Unlike qloo, there is no demo-mode fallback: deleting the Secret takes the site
down rather than switching to the fake PayPal.

The app also refuses a sqlite file of another schema version, so an upgrade that changes the schema needs a fresh
`DB_PATH` (or the old file moved away).

In the commands below, `K` is the admin's ssh (`ubuntu@130.61.238.6`, key `~/.ssh/oraculum-oci`) and `D` is the
deploy user's (`deploy@130.61.238.6`, key `~/.ssh/oraculum-deploy`), whose forced command is the deploy gate. Run them
from bash, not zsh (zsh doesn't split `${K[@]}`), in this repo's main checkout:

```bash
K=(-i ~/.ssh/oraculum-oci -o ConnectTimeout=15 ubuntu@130.61.238.6)
D=(-i ~/.ssh/oraculum-deploy -o IdentitiesOnly=yes -o BatchMode=yes deploy@130.61.238.6)
```

## 0. Before the first deploy

The monorepo side (the gate and the security.sh `paypal` block) is written:

| What | Where (monorepo) | What it does |
|---|---|---|
| The gate admits the image and namespace | `ops/oracle/remote/deploy-gate.sh` | `SERVICES` gains `ambree-paypal` (image `oraculum/ambree-paypal:<sha7>`), `APP_NAMESPACES` gains `paypal` |
| The Ingress host | `deploy-gate.sh` `INGRESS_HOST_RE` | Admits any subdomain of `ambree.ai`: `paypal.ambree.ai` needs no change |
| Namespace, quotas, NetworkPolicies, PVC | `ops/oracle/security.sh`, the paypal block | PSA restricted; `paypal-low` = 100; `paypal-cap` (requests 100m / 256Mi, limits 1 / 600Mi, 3 pods, 1 PVC, 64Mi storage); `paypal-limits` (per container max 500m / 256Mi); `paypal-priority-guard`; in from Traefik on :8080, out to DNS, out to TCP 443 public only; PVC `paypal-data` (64Mi, `local-path`) |
| Labels the policies select | same | `app.kubernetes.io/name: ambree-paypal` on the pod template (`deploy/k8s/deployment.yaml`) |

- TODO-CHECK: the monorepo branch that holds the paypal gate and security.sh change is merged to `main`.
- The gate is installed on the host from `origin/main` (`deploy-paypal.sh --go gate`, as qloo's).

The app side: fill the plain values in `deploy/k8s/deployment.yaml` (none is a secret), commit, and merge `ops/host`
into `main`. The deploy builds `main`, and `deploy-paypal.sh` refuses a render with any of these empty:

- TODO-CHECK: `PAYPAL_GUIDE_PAYEE_MERCHANT_ID`: the merchant id of the sandbox business account that plays every
  guide (its profile in the PayPal developer dashboard).
- TODO-CHECK: `PAYPAL_OPERATOR_MERCHANT_ID`: the REST app owner's own sandbox merchant id. It must differ from the
  guide's.
- TODO-CHECK: `LLM_MODEL`, and that the provider is OpenRouter (`LLM_BASE_URL` is `https://openrouter.ai/api/v1`;
  the app calls `<LLM_BASE_URL>/chat/completions`).
- TODO-CHECK: the spike's S11 row shows that PayPal returns a `payer_id` for the app's token. If it doesn't, the pod
  refuses to start. `PAYPAL_OPERATOR_IDENTITY=config-only` would start it on the configured id alone (unconfirmed):
  that is a CEO/CTO decision, never a default, and this repo doesn't set it.
- TODO-CHECK: the base image's Node is at least 22.18 (TypeScript type stripping on by default) and has `node:sqlite`
  without a flag (22.13+). Qloo runs `node src/server.ts` on the same digest; step 6's `/healthz` proves both here.

## 1. DNS

An `A` record `paypal.ambree.ai` → 130.61.238.6, DNS-only (not proxied), the same as `qloo.ambree.ai`. The Cloudflare
token is IP-locked to the host, so the API call runs **on the prod host only**: `deploy-paypal.sh --go dns` sends the
token from the Mac Keychain (`oraculum-cloudflare-token`) over ssh stdin, never in argv or a file, and creates the
record unless it exists. It must resolve publicly **before** step 5: Traefik asks Let's Encrypt once and doesn't
retry a failed certificate on its own. Check:

```bash
dig +short A paypal.ambree.ai @andronicus.ns.cloudflare.com   # 130.61.238.6
dig +short A paypal.ambree.ai @1.1.1.1                        # 130.61.238.6
```

## 2. The security.sh block

From the monorepo at `main`:

```bash
ssh "${K[@]}" 'sudo bash -s' < ops/oracle/security.sh
```

Its last line must read
`paypal: psa restricted | netpols allow-dns-egress allow-from-traefik allow-https-egress default-deny | quotas paypal-cap paypal-priority-guard | priorityclass paypal-low=100`.
The PVC `paypal-data` then exists. `local-path` binds on first use, so it stays `Pending` until the pod is
scheduled in step 5. `deploy-paypal.sh --go check` reads all of this back (read-only).

## 3. The Secret, by hand

Secret `paypal/paypal-secrets`, created by the admin, never by a manifest or a script that holds values. Its keys
(names only): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `LLM_API_KEY`, `MCP_DEMO_PASSCODE`.

- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`: the sandbox REST app's credentials. Required, not empty.
- `LLM_API_KEY`: the model key. Required, not empty.
- `PAYPAL_WEBHOOK_ID`: may be empty at first (the endpoint then answers 503, PayPal retries, and capture still
  happens on the return URL); set it in step 6.
- `MCP_DEMO_PASSCODE`: may be empty (then `/mcp` answers 401). Clients send it as a Bearer token.

Each value is typed at a hidden prompt on the host (`read -s`: not echoed). It reaches kubectl on stdin only:
never argv, a file, an echo, shell history or a log. The Secret is created empty if missing, then patched one key at
a time, as qloo's `store-key.sh` does. Never `kubectl apply` a Secret: apply copies the whole object, values
included, into the last-applied-configuration annotation. The script below is plain text and holds no value; the
last thing it prints is each key's name with `set` or `EMPTY`.

```bash
IFS= read -r -d '' S <<'EOS' || true
set -euo pipefail
k() { k3s kubectl -n paypal "$@"; }
k get secret paypal-secrets -o name >/dev/null 2>&1 || k create secret generic paypal-secrets >/dev/null
for key in "$@"; do
  v=""
  IFS= read -rs -p "$key (hidden; Enter alone = empty): " v
  printf '\n' >&2
  printf '%s' "$v" | k create secret generic paypal-secrets --from-file="$key"=/dev/stdin --dry-run=client -o json |
    jq '{data}' | k patch secret paypal-secrets --patch-file /dev/stdin >/dev/null
  unset v
  echo "$key: stored"
done
k get secret paypal-secrets -o json | jq -r '.data // {} | to_entries[] | "\(.key) \(if (.value | length) > 0 then "set" else "EMPTY" end)"'
EOS
ssh -t "${K[@]}" "sudo bash -c $(printf %q "$S") store-secrets PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET PAYPAL_WEBHOOK_ID LLM_API_KEY MCP_DEMO_PASSCODE"
```

To change one key later, run the same `ssh` line with only that key's name, then restart the pod (a Secret is read
at start):

```bash
ssh "${K[@]}" 'sudo k3s kubectl -n paypal rollout restart deployment/paypal-web && sudo k3s kubectl -n paypal rollout status deployment/paypal-web --timeout=300s'
```

- TODO-CHECK: the OpenRouter key has a spend cap that holds until 15 Dec.
- TODO-CHECK: where the MCP passcode is given to the judges (never in git or a public page).

## 4. Build the image on the host

From this repo on the Mac. The tag is the 7-char sha of `main`. `git archive` streams the committed tree (not the
working tree) to the gate, which builds it with nerdctl + BuildKit (native arm64) into k3s containerd:

```bash
T=$(git rev-parse main | cut -c1-7)
ssh "${D[@]}" "images ambree-paypal"
git archive --format=tar main | gzip -c | ssh "${D[@]}" "build ambree-paypal $T"
```

## 5. Apply

Render `deploy/k8s` at `main` through an overlay that sets the tag. `kustomization.yaml` ships with
`newTag: set-by-deploy`, which would fail with `ErrImageNeverPull` rather than run a stale image:

```bash
O=$(mktemp -d); mkdir "$O/src" "$O/overlay"; git archive main deploy/k8s | tar -x -C "$O/src"
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../src/deploy/k8s\nimages:\n  - name: oraculum/ambree-paypal\n    newTag: "%s"\n' "$T" > "$O/overlay/kustomization.yaml"
kubectl kustomize "$O/overlay" > "$O/rendered.yaml"; grep -E 'image:|claimName:|name: paypal-secrets' "$O/rendered.yaml"
ssh "${D[@]}" "apply" < "$O/rendered.yaml"
ssh "${D[@]}" "rollout-status paypal deployment/paypal-web 300"
```

The `grep` must print `image: oraculum/ambree-paypal:<T>`, `claimName: paypal-data` and five
`name: paypal-secrets`. The render holds no `kind: Secret` and no `kind: PersistentVolumeClaim`.
`deploy-paypal.sh --go apply` checks all of that, plus the plain values from step 0, and runs `rollout-undo` itself
if a changed rollout fails.

## 6. Smoke

```bash
curl -s https://paypal.ambree.ai/healthz
ssh "${K[@]}" 'sudo k3s kubectl -n paypal get pods -l app.kubernetes.io/name=ambree-paypal'
```

`/healthz` must show `"ok":true`, `"paypal":"sandbox"`, `"model":"openai"` and `"operator_identity":"confirmed"`.
The server listens only after the operator check passed, so an answer at all means the config loaded, sqlite opened
`/data/ambree.sqlite` and PayPal confirmed the operator. `deploy-paypal.sh --go verify` checks the same, and the
certificate (`cert` step).

- TODO-CHECK: the pod shows 0 restarts. k3s admits a new pod's IP to its NetworkPolicies about 1 s after it starts,
  and the app calls PayPal at startup; one early restart there is that race, not a fault.
- The data survives a restart: `curl -s https://paypal.ambree.ai/api/ledger/head` gives the same checkpoint
  before and after the restart command in step 3.

Then the webhook, once the site answers:
1. In the sandbox app, add a webhook:
   - URL: `https://paypal.ambree.ai/webhooks/paypal`.
   - Events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`,
     `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REVERSED`.
   - TODO-CHECK: add the refund failure events too, by their exact names in the dashboard's list (S12's P4
     in DESIGN.md §5: the spike run can't answer it).
     The handler already takes any `PAYMENT.REFUND.*`, such as a refund that was PENDING and then failed.
     Without them, such a refund held for an unknown outcome gets no notice, and a person reconciles it
     (DESIGN.md §19).
2. Store its id with step 3's `ssh` line for `PAYPAL_WEBHOOK_ID` alone, then restart.
3. TODO-CHECK: one `POST /v1/notifications/simulate-event`, or a real checkout, shows a `webhook.*` row in the
   ledger.

Run the README's judge steps once with the sandbox buyer.

- TODO-CHECK: uptime monitoring (qloo has none to copy).
- TODO-CHECK: rate limits. This app has body-size limits but no per-IP limiter yet. With a live LLM key every chat
  turn costs money, and the OpenRouter spend cap is the only bound until a limiter (as qloo's
  `src/http/rate-limit.ts`) lands.

## 7. Rollback

- A failed or bad image: `ssh "${D[@]}" "rollout-undo paypal deployment/paypal-web"`, then
  `ssh "${D[@]}" "rollout-status paypal deployment/paypal-web 300"`. `Recreate` means a short outage either way.
- A wrong Secret value: step 3 for that key, then the restart.
- Off at once, data kept on the PVC: `ssh "${K[@]}" 'sudo k3s kubectl -n paypal scale deployment/paypal-web --replicas=0'`.
  Back: the same with `--replicas=1`.
- An image whose schema version differs from the file's refuses to start; roll back to the previous image. Moving
  the old file away loses the ledger and bookings (TODO-CHECK: a CTO decision, only if a new schema must ship).

## 8. Take-down on 15 Dec

Keep it up until judging ends. TODO-CHECK: the exact end of judging (15 Dec 2026 per the plan) in the hackathon rules.
Then, in this order:

1. TODO-CHECK: keep a copy of the sqlite file? It holds sandbox data only. If yes, copy it out of the pod before
   step 2: `ssh "${K[@]}" 'sudo k3s kubectl -n paypal exec deploy/paypal-web -- cat /data/ambree.sqlite' > ambree-paypal-final.sqlite`
   (stop traffic first; the -wal file may hold the last writes).
2. The app's objects and the Secret, as the admin:
   `ssh "${K[@]}" 'sudo k3s kubectl -n paypal delete ingress/paypal-web service/paypal-web deployment/paypal-web secret/paypal-secrets'`.
3. The DNS record `paypal.ambree.ai` (Cloudflare, from the host, as in step 1).
4. The monorepo: remove the paypal block from `ops/oracle/security.sh` and the `ambree-paypal` / `paypal` gate
   entries, merge, reinstall the gate. `security.sh` only applies, so then delete by hand:
   `ssh "${K[@]}" 'sudo k3s kubectl delete ns paypal && sudo k3s kubectl delete priorityclass paypal-low'`
   (the namespace takes the PVC, the quotas and the NetworkPolicies with it).
5. PayPal and the model: delete the sandbox webhook and REST app; revoke the OpenRouter key (TODO-CHECK: who holds
   that account).
