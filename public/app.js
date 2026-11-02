// The chat page: talks to /api/chat and /api/state, renders the approval card, pay button, guide's
// phone, inbox and ledger. Polls state so guide answers and webhooks show up without a reload.
import { demoMessage, demoView, paymentLine, simulateControl } from "/labels.js";

// The session cookie (HttpOnly) is the traveller's authority. Each tab keeps its own conversation id in
// sessionStorage and sends it with every request; the server checks the session owns it.
const $ = (id) => document.getElementById(id);

let busy = false;
let last = null;
let conv = sessionStorage.getItem("ambree_conv");

async function newConversation() {
  const s = await api("/api/conversations", {}, false);
  conv = s.conversation_id;
  sessionStorage.setItem("ambree_conv", conv);
  return s;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("data-")) e.setAttribute(k, v);
    else e[k] = v;
  }
  for (const c of children) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const money = (m) => (m ? `${m.currency_code} ${m.value}` : "");

async function api(path, body, withConv = true) {
  let url = path;
  if (withConv && !body) url += `${path.includes("?") ? "&" : "?"}conversation_id=${encodeURIComponent(conv)}`;
  const payload = body && withConv ? { ...body, conversation_id: conv } : body;
  const res = await fetch(url, payload ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {});
  if (res.status === 404 && withConv && (path.startsWith("/api/state") || path === "/api/chat")) {
    // This tab's conversation isn't in the session (new cookie, or another browser): start a fresh one.
    await newConversation();
    return api(path, body, withConv);
  }
  return res.json();
}

function render(s) {
  last = s;
  $("mode").textContent = `PayPal: ${s.mode.paypal === "fake" ? "offline fake (same JSON as the sandbox)" : "sandbox"} · model: ${s.mode.model}`;
  const demo = demoView(s.mode.paypal);
  $("demo-controls").hidden = !demo.controls;
  const sim = simulateControl(s.mode.paypal, s.bookings);
  $("raise-cyclone").disabled = sim.disabled;
  $("simulate-why").textContent = sim.hint;
  $("simulate-why").hidden = !sim.hint;

  const t = $("transcript");
  t.replaceChildren(...s.transcript.map((m) => el("li", { class: m.role, "data-role": m.role }, m.role === "event" ? m.text.replace(/^\[event\] \w+ bk_[0-9a-f]+: /, "◆ ") : m.text)));
  t.scrollTop = t.scrollHeight;

  $("guide-phone").replaceChildren(...(s.guide_phone.length ? s.guide_phone.map((l) => el("li", {}, `${l.guide_name}: `, el("a", { href: l.url, target: "_blank", rel: "noopener", "data-testid": "operator-link" }, "open request"))) : [el("li", { class: "small" }, "No requests yet.")]));
  $("inbox").replaceChildren(...(s.inbox.length ? s.inbox.map((m) => el("li", { "data-testid": "inbox-msg" }, m.text)) : [el("li", { class: "small" }, "Empty.")]));

  $("chain").textContent = s.chain.ok ? `Chain OK: ${s.chain.count} rows, head ${s.chain.head.slice(0, 12)}…` : `CHAIN BROKEN at row ${s.chain.bad_seq}: ${s.chain.reason}`;
  $("chain").dataset.ok = String(s.chain.ok);
  $("ledger").replaceChildren(...s.ledger.map((e) => el("li", { "data-kind": e.kind }, el("span", { class: "mono" }, `#${e.seq} ${e.hash.slice(0, 10)}`), ` ${e.kind}`)));

  const cards = [];
  for (const b of s.bookings) {
    const c = el("div", { class: "card booking", "data-testid": "booking", "data-status": b.status });
    c.append(el("h3", {}, `${b.guide.name} · ${b.activity} · ${b.date}`), el("p", { class: "small" }, `status `, el("strong", { "data-testid": "booking-status" }, b.status)));
    if (b.quote) c.append(el("p", {}, `Quote: total ${money(b.quote.total)}, deposit ${money(b.quote.deposit)} → ${b.quote.payee}`), el("p", { class: "small mono" }, `quote hash ${b.quote.quote_hash}`));
    if (b.status === "mandate_proposed" && b.mandate && b.mandate.status === "proposed") {
      const code = el("input", { inputMode: "numeric", maxLength: 6, placeholder: "6-digit code", "data-testid": "code" });
      const msg = el("p", { class: "small", "data-testid": "approve-msg" });
      const btn = el("button", { type: "button", "data-testid": "approve" }, `Approve ${money(b.mandate.amount)} to the guide`);
      btn.onclick = async () => {
        const r = await api(`/api/mandates/${b.mandate.id}/approve`, { code: code.value.trim() });
        if (r.ok) {
          render(r);
          void tick(true);
        } else msg.textContent = r.error;
      };
      c.append(
        el("div", { class: "approval", "data-testid": "approval-card" },
          el("h4", {}, "Approve this payment mandate"),
          el("dl", {}, el("dt", {}, "Amount"), el("dd", {}, money(b.mandate.amount)), el("dt", {}, "Payee"), el("dd", {}, b.mandate.payee), el("dt", {}, "Quote hash"), el("dd", { class: "mono" }, b.mandate.quote_hash.slice(0, 16) + "…"), el("dt", {}, "Expires"), el("dd", {}, new Date(b.mandate.expires_at).toLocaleTimeString())),
          code, btn, msg));
    }
    if (b.order && b.order.approve_url && b.status === "order_created") c.append(el("a", { class: "button pay", href: b.order.approve_url, "data-testid": "pay" }, "Pay the guide in PayPal"));
    const pay = paymentLine(b);
    if (pay) c.append(el("p", { "data-testid": pay.testid }, pay.text));
    if (b.refunded && b.refunded.value !== "0.00") c.append(el("p", { "data-testid": "refunded" }, `Refunded ${money(b.refunded)}.`));
    if (b.simulated_warning) c.append(el("p", { class: "small", "data-testid": "simulated-warning" }, `Simulated cyclone warning (demo) for ${b.simulated_warning.date}: not a real warning.`));
    if (b.reschedule) c.append(el("p", { class: "small" }, `Reschedule to ${b.reschedule.new_date}: ${b.reschedule.status}`));
    if (demo.guideBalance && b.guide_balance !== null) c.append(el("p", { class: "small", "data-testid": "guide-balance" }, `Guide's sandbox balance (fake): ${(b.guide_balance / 100).toFixed(2)}`));
    cards.push(c);
  }
  $("cards").replaceChildren(...cards);
}

async function tick(force) {
  if (busy) return;
  const s = await api("/api/state");
  if (s.pending_events > 0 || force) {
    busy = true;
    try {
      render(await api("/api/chat", {}));
    } finally {
      busy = false;
    }
  } else render(s);
}

$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("message").value.trim();
  if (!text || busy) return;
  busy = true;
  $("send").disabled = true;
  $("message").value = "";
  try {
    render(await api("/api/chat", { message: text }));
  } finally {
    busy = false;
    $("send").disabled = false;
  }
};
$("raise-cyclone").onclick = async () => {
  // The newest booking in this tab (the sandbox server acts on that one booking only; the fake ignores it).
  const newest = last?.bookings.at(-1);
  const r = await api("/api/demo/cyclone", newest ? { booking_id: newest.booking_id } : {});
  $("demo-msg").textContent = demoMessage(r);
  void tick(true);
};
$("new-conv").onclick = async () => {
  $("demo-msg").textContent = "";
  render(await newConversation());
};

if (!conv) await newConversation();
void tick(false);
setInterval(() => void tick(false), 1500);
