# Deploying ambree-paypal (example: a single-node k3s cluster)

The hosted demo, https://paypal.ambree.ai, runs this way:
- one pod in its own namespace, `paypal`, on a single-node k3s cluster;
- the image is built on the node and run with `imagePullPolicy: Never`;
- Traefik routes the host and gets its Let's Encrypt certificate.

The commands below are plain `kubectl`, run as the cluster admin (on a k3s node, `sudo k3s kubectl`). Run them from
bash in a checkout of this repo. Change the host, the image and the plain values for your own cluster.

| File | What it is |
|---|---|
| `Dockerfile`, `.dockerignore` | digest-pinned node:22-alpine, `npm ci --omit=dev --ignore-scripts`, runs as `node`, read-only root filesystem, sqlite on `/data` |
| `deploy/k8s/` | Deployment, Service and Ingress `paypal-web` for `paypal.ambree.ai`, namespace `paypal`, image `oraculum/ambree-paypal` (`kubectl kustomize deploy/k8s` renders 3 objects: no Secret, no PVC) |
| `scripts/spike.ts` | The sandbox check (third-party payee, capture, refund); it can also run in the pod |

**It fails closed, never open.** The app refuses any live PayPal URL. It uses two sandbox REST apps (DESIGN.md
§21): the operator's (`PAYPAL_CLIENT_ID`) makes and captures the orders, and the guide's own (`PAYPAL_GUIDE_CLIENT_ID`,
owned by the guide's sandbox business account) makes the refunds, which PayPal refuses to the operator's app. With
`PAYPAL_OPERATOR_IDENTITY` unset (the default, `paypal`) it asks PayPal at startup who owns each app: it creates an
order with no payee under each app's token (an identity check, never approved; it lapses) and reads the payee
PayPal echoes. It refuses to start, naming the check that failed ("Operator identity check failed" or "Guide
identity check failed"), unless the operator's app is owned by `PAYPAL_OPERATOR_MERCHANT_ID`, which is no guide's
payee, and the guide's app by `PAYPAL_GUIDE_PAYEE_MERCHANT_ID`. Every Secret key is required, so with no Secret
`paypal-secrets` (or a missing key) the pod stays at `CreateContainerConfigError`. Empty merchant ids or an empty
`LLM_MODEL` make it refuse to start. So a pod that won't start after step 5 is a config or Secret problem, not an
infra one: its log names the variable (never the value). There is no demo-mode fallback: deleting the Secret takes
the site down rather than switching to the fake PayPal.

The app also refuses a sqlite file of another schema version, so an upgrade that changes the schema needs a fresh
`DB_PATH` (or the old file moved away).

## 0. Prerequisites

The manifests don't create these; the cluster admin does, once:
- the namespace `paypal` (Pod Security `restricted` admits the pod);
- the PVC `paypal-data` (64Mi, ReadWriteOnce), which holds the sqlite file;
- the PriorityClass `paypal-low` (or remove `priorityClassName` from `deploy/k8s/deployment.yaml`);
- the Secret `paypal-secrets` (step 3);
- optionally a quota, a LimitRange and NetworkPolicies. The policies select the pod by
  `app.kubernetes.io/name: ambree-paypal`: in from the ingress controller on :8080, out to DNS, out to TCP 443. The
  container asks for 25m / 96Mi and is limited to 200m / 256Mi.

```bash
kubectl create namespace paypal
kubectl label namespace paypal pod-security.kubernetes.io/enforce=restricted
kubectl apply -f - <<'EOF'
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: paypal-low
value: 100
globalDefault: false
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: paypal-data
  namespace: paypal
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 64Mi
EOF
```

On k3s the default `local-path` class binds on first use, so the PVC stays `Pending` until the pod is scheduled in
step 5.

## 1. DNS

An `A` record for the host (here `paypal.ambree.ai`), DNS-only, must resolve publicly before the first apply:
Traefik requests the certificate only once.

## 2. The plain values

`deploy/k8s/deployment.yaml` holds the values that are not secrets; the repo's are the hosted demo's. Empty, the
pod refuses to start:
- `PAYPAL_GUIDE_PAYEE_MERCHANT_ID`: the merchant id of the sandbox business account that plays every guide (its
  profile in the PayPal developer dashboard).
- `PAYPAL_OPERATOR_MERCHANT_ID`: the operator's REST app owner's own sandbox merchant id. It must differ from the
  guide's.
- `LLM_BASE_URL` and `LLM_MODEL`: an OpenAI-compatible provider (the hosted demo uses OpenRouter,
  `https://openrouter.ai/api/v1`; the app calls `<LLM_BASE_URL>/chat/completions`) and a model with tool calling.
- `PUBLIC_URL`: the site's URL, where PayPal sends the buyer back, and the one Origin the page's POSTs are accepted
  from.

**The identity check.** The spike (3 Nov) found that userinfo has no `payer_id` for an app token (S11: no), and that
the payee echo of an order with no payee names each app's owner (equal to the dashboard's merchant id, for the
operator's app and the guide's). The check uses the echo. So the guide's REST app must be created in the guide's
sandbox business account: its payee echo must be `PAYPAL_GUIDE_PAYEE_MERCHANT_ID`, or the pod refuses to start.
`PAYPAL_OPERATOR_IDENTITY=config-only` would start the pod on the configured ids alone (unconfirmed, for both apps):
an explicit choice, never a default, and this repo doesn't set it.

The image's Node must be at least 22.18 (TypeScript type stripping on by default) and have `node:sqlite` without a
flag (22.13+). The Dockerfile's pinned digest does; step 6's `/healthz` proves both.

## 3. The Secret, by hand

Secret `paypal/paypal-secrets`, created by the admin, never by a manifest or a script that holds values. Its eight
keys (names only): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_GUIDE_CLIENT_ID`,
`PAYPAL_GUIDE_CLIENT_SECRET`, `PAYPAL_GUIDE_WEBHOOK_ID`, `LLM_API_KEY`, `MCP_DEMO_PASSCODE`.

- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`: the operator's sandbox REST app (orders and captures). Required, not
  empty.
- `PAYPAL_GUIDE_CLIENT_ID`, `PAYPAL_GUIDE_CLIENT_SECRET`: the guide's own sandbox REST app, created in the guide's
  sandbox business account (the refunds). Required, not empty, and not the operator's app.
- `LLM_API_KEY`: the model key. Required, not empty.
- `PAYPAL_WEBHOOK_ID`: the operator app's webhook. May be empty at first (`/webhooks/paypal` then answers 503,
  PayPal retries, and capture still happens on the return URL); set it in step 6.
- `PAYPAL_GUIDE_WEBHOOK_ID`: the guide app's webhook. May be empty at first (`/webhooks/paypal/guide` then answers
  503 and PayPal retries). A refund's own reply still records it, and `get_booking` reads a pending one, but a
  refund whose reply was lost waits for a notice that only an endpoint with its id can verify; set it in step 6.
- `MCP_DEMO_PASSCODE`: may be empty (then `/mcp` answers 401). Clients send it as a Bearer token. Give it to its
  users out of band, never in git or on a public page.

Each value is typed at a hidden prompt (`read -s`: not echoed). It reaches kubectl on stdin only: never argv, a
file, an echo, shell history or a log. The Secret is created empty if missing, then patched one key at a time.
Never `kubectl apply` a Secret: apply copies the whole object, values included, into the
last-applied-configuration annotation. The script below holds no value; the last thing it prints is each key's
name with `set` or `EMPTY`. It needs bash and `jq`.

```bash
store_secrets() {
  kubectl -n paypal get secret paypal-secrets -o name >/dev/null 2>&1 ||
    kubectl -n paypal create secret generic paypal-secrets >/dev/null
  local key v
  for key in "$@"; do
    v=""
    IFS= read -rs -p "$key (hidden; Enter alone = empty): " v
    printf '\n' >&2
    printf '%s' "$v" | kubectl -n paypal create secret generic paypal-secrets --from-file="$key"=/dev/stdin --dry-run=client -o json |
      jq '{data}' | kubectl -n paypal patch secret paypal-secrets --patch-file /dev/stdin >/dev/null
    unset v
    echo "$key: stored"
  done
  kubectl -n paypal get secret paypal-secrets -o json |
    jq -r '.data // {} | to_entries[] | "\(.key) \(if (.value | length) > 0 then "set" else "EMPTY" end)"'
}
store_secrets PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET PAYPAL_WEBHOOK_ID PAYPAL_GUIDE_CLIENT_ID PAYPAL_GUIDE_CLIENT_SECRET PAYPAL_GUIDE_WEBHOOK_ID LLM_API_KEY MCP_DEMO_PASSCODE
```

To change one key later, run `store_secrets` with only that key's name, then restart the pod (a Secret is read at
start):

```bash
kubectl -n paypal rollout restart deployment/paypal-web
kubectl -n paypal rollout status deployment/paypal-web --timeout=300s
```

## 4. Build the image

The tag is the 7-char sha of the commit you deploy. Build the committed tree, not the working tree:

```bash
T=$(git rev-parse HEAD | cut -c1-7)
D=$(mktemp -d); git archive --format=tar HEAD | tar -x -C "$D"
docker build -t "oraculum/ambree-paypal:$T" "$D"
```

`imagePullPolicy: Never` needs the image in the node's own container runtime. On k3s, either build on the node
with a containerd-native builder, or import the image there:
`docker save "oraculum/ambree-paypal:$T" -o ambree-paypal.tar`, then on the node
`sudo k3s ctr images import ambree-paypal.tar`. With a registry instead, push the image, and set its name and
`imagePullPolicy: IfNotPresent` in your overlay.

## 5. Apply

Render `deploy/k8s` at that commit through an overlay that sets the tag. `kustomization.yaml` ships with
`newTag: set-by-deploy`, which would fail with `ErrImageNeverPull` rather than run a stale image:

```bash
O=$(mktemp -d); mkdir "$O/src" "$O/overlay"; git archive HEAD deploy/k8s | tar -x -C "$O/src"
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../src/deploy/k8s\nimages:\n  - name: oraculum/ambree-paypal\n    newTag: "%s"\n' "$T" > "$O/overlay/kustomization.yaml"
kubectl kustomize "$O/overlay" > "$O/rendered.yaml"; grep -E 'image:|claimName:|name: paypal-secrets' "$O/rendered.yaml"
kubectl apply -f "$O/rendered.yaml"
kubectl -n paypal rollout status deployment/paypal-web --timeout=300s
```

The `grep` must print `image: oraculum/ambree-paypal:<T>`, `claimName: paypal-data` and eight
`name: paypal-secrets`. The render holds no `kind: Secret` and no `kind: PersistentVolumeClaim`. If a changed
rollout fails, roll back (step 7).

## 6. Smoke

```bash
curl -s https://paypal.ambree.ai/healthz
kubectl -n paypal get pods -l app.kubernetes.io/name=ambree-paypal
```

`/healthz` must show `"ok":true`, `"paypal":"sandbox"`, `"model":"openai"`, `"operator_identity":"confirmed"` and
`"guide_identity":"confirmed"`. The server listens only after both identity checks passed, so an answer at all means
the config loaded, sqlite opened `/data/ambree.sqlite` and PayPal confirmed who owns each app. Each check leaves one
probe order (no payee, never approved) in its app's sandbox account; it lapses.

- With NetworkPolicies, k3s admits a new pod's IP to them about 1 s after it starts, and the app calls PayPal at
  startup; one early restart there is that race, not a fault.
- The data survives a restart: `curl -s https://paypal.ambree.ai/api/ledger/head` gives the same checkpoint
  before and after the restart command in step 3.

Then the two webhooks, once the site answers (each app has its own; DESIGN.md §21):
1. In the operator's sandbox app, add a webhook:
   - URL: `https://paypal.ambree.ai/webhooks/paypal`.
   - Events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`,
     `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REVERSED`.
   - The refund events, by the names in the dashboard's event list (S12's P4, answered 3 Nov):
     `PAYMENT.REFUND.CANCELLED`, `PAYMENT.REFUND.COMPLETED`, `PAYMENT.REFUND.DENIED`, `PAYMENT.REFUND.FAILED`,
     `PAYMENT.REFUND.PENDING`.
     The handler takes any `PAYMENT.REFUND.*`, such as a refund that was PENDING and then failed.
     Without them, such a refund held for an unknown outcome gets no notice, and a person reconciles it
     (DESIGN.md §19).
2. In the guide's own sandbox app (the one in `PAYPAL_GUIDE_CLIENT_ID`), add a second webhook:
   - URL: `https://paypal.ambree.ai/webhooks/paypal/guide`.
   - Events: the same refund events: `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`,
     `PAYMENT.REFUND.CANCELLED`, `PAYMENT.REFUND.COMPLETED`, `PAYMENT.REFUND.DENIED`, `PAYMENT.REFUND.FAILED`,
     `PAYMENT.REFUND.PENDING`.
   - On the 5 Nov hosted smoke PayPal tied every webhook event, the refund's included, to the operator's app
     (DESIGN.md §21). The guide's webhook stays subscribed anyway: the same event arriving on both is processed
     once (the handler dedupes by event id), and each endpoint accepts only its own app's webhook id.
3. Store each id with step 3's `store_secrets` for that key alone (`PAYPAL_WEBHOOK_ID`, `PAYPAL_GUIDE_WEBHOOK_ID`),
   then restart.
4. A real checkout and refund (or one `POST /v1/notifications/simulate-event`) shows `webhook.*` rows in the
   ledger. The pod's log line `{"event":"webhook","endpoint":...}` names the endpoint each came on. Sandbox
   webhooks can arrive late; the return URL captures the payment without them.

Run the README's judge steps once with the sandbox buyer.

## 7. Rollback

- A failed or bad image: `kubectl -n paypal rollout undo deployment/paypal-web`, then
  `kubectl -n paypal rollout status deployment/paypal-web --timeout=300s`. `Recreate` means a short outage either
  way.
- A wrong Secret value: step 3 for that key, then the restart.
- Off at once, data kept on the PVC: `kubectl -n paypal scale deployment/paypal-web --replicas=0`. Back: the same
  with `--replicas=1`.
- An image whose schema version differs from the file's refuses to start; roll back to the previous image. Moving
  the old file away loses the ledger and bookings: do it only if a new schema must ship.

## 8. Take-down

The hosted demo stays up during judging, until at least 31 Jan 2027. Then, in this order:

1. If you want a copy of the sqlite file (it holds sandbox data only), copy it out of the pod before step 2, with
   traffic stopped (the -wal file may hold the last writes):
   `kubectl -n paypal exec deploy/paypal-web -- cat /data/ambree.sqlite > ambree-paypal-final.sqlite`.
2. The app's objects and the Secret:
   `kubectl -n paypal delete ingress/paypal-web service/paypal-web deployment/paypal-web secret/paypal-secrets`.
3. The DNS record for the host.
4. The prerequisites: `kubectl delete namespace paypal` and `kubectl delete priorityclass paypal-low` (the
   namespace takes the PVC, the quotas and the NetworkPolicies with it).
5. PayPal and the model: delete both sandbox webhooks and both REST apps (the operator's and the guide's); revoke
   the model key.
