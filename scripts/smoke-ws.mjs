const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
const B = "http://localhost:8787/api";
const j = (r) => r.json();

await fetch(`${B}/demo/seed`, { method: "POST", headers: H, body: JSON.stringify({ scenario: "cron_cpu_spike" }) }).then(j);
const { id } = await fetch(`${B}/incidents`, { method: "POST", headers: H, body: JSON.stringify({ description: "Checkout pages are slow, some 504s" }) }).then(j);
console.log("incident", id);

const ws = new WebSocket(`ws://localhost:8787/api/incidents/${id}/ws?token=dev-token`);
const seen = [];
let actionId;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  seen.push(m.type);
  if (m.type === "investigation_progress") console.log("progress:", m.phase, JSON.stringify(m.detail).slice(0, 100));
  if (m.type === "assistant_done") console.log("assistant:", (m.message?.content ?? "").slice(0, 140).replace(/\n/g, " | "));
  if (m.type === "approval_request" && !actionId) {
    actionId = m.action.id;
    console.log("approval_request:", m.action.type, m.action.target, "→ rejecting");
    ws.send(JSON.stringify({ type: "approval_decision", clientMsgId: "d1", actionId, approved: false }));
  }
  if (m.type === "error") console.log("error:", m.message);
};
await new Promise((r) => (ws.onopen = r));
const msg = { type: "user_message", clientMsgId: "same-id", text: "Checkout pages are slow, some 504s" };
ws.send(JSON.stringify(msg));
ws.send(JSON.stringify(msg));
ws.send("not json");

await new Promise((r) => setTimeout(r, 12000));
ws.close();

const snap = await fetch(`${B}/incidents/${id}`, { headers: H }).then(j);
console.log("frames:", [...new Set(seen)].join(","));
console.log("user messages:", snap.messages.filter((m) => m.role === "user").length);
console.log("incident:", snap.incident.status, "| investigation:", snap.investigation.status, snap.investigation.phase);
for (const h of snap.hypotheses) console.log("  hyp", h.rank, h.confidence, h.category, h.title);
for (const a of snap.actions) console.log("  action", a.type, a.target, a.status, a.decided_by);
