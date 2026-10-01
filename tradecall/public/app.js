// TradeCall owner app — no build step. Everything from the API passes
// through esc() before it reaches innerHTML.
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const STAGES = ["NEW", "ENGAGED", "QUALIFIED", "SCHEDULED", "WON", "LOST"];
const STAGE = { NEW: "New", ENGAGED: "Replied", QUALIFIED: "Qualified", SCHEDULED: "Booked", WON: "Won", LOST: "Lost" };
const MISS = { NO_ANSWER: "Didn't pick up", CALLER_HUNG_UP: "Hung up while ringing", NOT_ACCEPTED: "Went to your voicemail", FORWARDED: "Forwarded by carrier" };
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
let ME = null;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const phone = (e) => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e || ""); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e || ""; };
const money = (c) => "$" + Math.round((c || 0) / 100).toLocaleString("en-US");
const pct = (x) => (x == null ? "–" : Math.round(x * 100) + "%");
const tz = () => ME?.business?.timezone;
const when = (iso, o = {}) => new Intl.DateTimeFormat("en-US", { timeZone: tz(), month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...o }).format(new Date(iso));
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), 3200);
}

async function api(path, { method = "GET", body } = {}) {
  const token = store.get("tc_token");
  const res = await fetch("/api" + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth")) {
    store.set("tc_token", null);
    ME = null;
    location.hash = "#/login";
    throw new Error(data.error || "Signed out");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------- routing ----------------

async function route() {
  const [, page = "dashboard", id] = (location.hash.replace(/^#/, "") || "/dashboard").split("/");
  const signedIn = Boolean(store.get("tc_token"));
  if (!signedIn || page === "login" || page === "signup") {
    if (signedIn) return (location.hash = "#/dashboard");
    $("#shell").hidden = true;
    $("#auth").hidden = false;
    return renderAuth(page === "signup");
  }
  $("#auth").hidden = true;
  $("#shell").hidden = false;
  try {
    if (!ME) ME = await api("/me");
  } catch {
    return;
  }
  $("#biz").textContent = ME.business.name;
  $("#biz-number").textContent = ME.business.phoneNumber ? phone(ME.business.phoneNumber) : "No number yet";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === page));
  notice();
  try {
    if (page === "inbox") await renderInbox(id);
    else if (page === "leads" && id) location.hash = `#/inbox/${id}`; // links from alert texts
    else if (page === "settings") await renderSettings();
    else await renderDashboard();
  } catch (e) {
    view.innerHTML = `<div class="panel err">${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
$("#signout").addEventListener("click", () => {
  store.set("tc_token", null);
  ME = null;
  location.hash = "#/login";
});

function notice() {
  const n = $("#notice");
  if (!ME.business.phoneNumber) {
    n.innerHTML = `Missed calls can't be texted back until you connect a number. <a href="#/settings">Set it up →</a>`;
  } else if (!ME.provider.live) {
    n.textContent = "Demo mode — no phone provider is connected on the server, so calls and texts are simulated.";
  } else return (n.hidden = true);
  n.hidden = false;
}

// ---------------- auth ----------------

function renderAuth(signup) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("#auth").innerHTML = `
    <div class="panel auth-card">
      <div class="mark">TC</div>
      <h1>${signup ? "Never lose a job to voicemail" : "Welcome back"}</h1>
      <p class="muted" style="margin:6px 0 18px">${signup ? "Missed a call on the job? The caller gets a text in seconds, and you get the lead." : "Sign in to TradeCall"}</p>
      <form id="f">
        ${signup ? `
        <label>Business name<input name="businessName" required maxlength="80" autocomplete="organization"></label>
        <label>Your first name<input name="ownerName" required maxlength="60" autocomplete="given-name"></label>
        <label>Your cell phone<input name="ownerPhone" type="tel" required autocomplete="tel" placeholder="(555) 123-4567">
          <div class="hint">We ring this first, and send lead alerts here. Reply to an alert to text the customer.</div></label>` : ""}
        <label>Email<input name="email" type="email" required autocomplete="email"></label>
        <label>Password<input name="password" type="password" required minlength="${signup ? 8 : 1}" autocomplete="${signup ? "new-password" : "current-password"}"></label>
        <div class="err" id="e"></div>
        <button class="btn" style="width:100%">${signup ? "Create my account" : "Sign in"}</button>
      </form>
      <p class="muted small" style="text-align:center;margin:14px 0 0">${signup ? `Already have an account? <a href="#/login">Sign in</a>` : `New here? <a href="#/signup">Create an account</a>`}</p>
    </div>`;
  $("#f").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    if (signup) body.timezone = zone;
    try {
      const r = await api(signup ? "/auth/signup" : "/auth/login", { method: "POST", body });
      store.set("tc_token", r.token);
      ME = null;
      location.hash = signup ? "#/settings" : "#/dashboard";
    } catch (e) {
      $("#e").textContent = e.message;
    }
  });
}

// ---------------- dashboard ----------------

let RANGE = Number(store.get("tc_range")) || 7;

function vs(cur, prev, fmt = (x) => x) {
  if (prev == null) return "";
  const d = cur - prev;
  return d === 0 ? `same as prior ${RANGE}d` : `${d > 0 ? "▲" : "▼"} ${fmt(Math.abs(d))} vs prior ${RANGE}d`;
}

async function renderDashboard() {
  const d = await api(`/dashboard?days=${RANGE}`);
  const c = d.current, p = d.previous;
  const reasons = Object.entries(c.missReasons).filter(([, n]) => n > 0);
  view.innerHTML = `
    <div class="head">
      <div><h1>Your last ${RANGE} days</h1><p>Every missed call, what happened next, and what it was worth.</p></div>
      <div class="seg" role="group" aria-label="Date range">${[7, 30, 90].map((n) => `<button data-r="${n}" aria-pressed="${n === RANGE}">${n} days</button>`).join("")}</div>
    </div>
    <div class="grid tiles">
      <div class="panel tile hero"><div class="k">Jobs saved (est.)</div><div class="v">${money(c.savedCents)}</div><div class="d">${c.replied} callers replied × ${money(d.avgJobCents)} avg job</div></div>
      <div class="panel tile"><div class="k">Missed calls</div><div class="v">${c.missed}</div><div class="d">${c.calls ? Math.round((c.missed / c.calls) * 100) + "% of calls" : "no calls yet"} · ${vs(c.missed, p.missed)}</div></div>
      <div class="panel tile"><div class="k">Texted back</div><div class="v">${c.textBacks}</div><div class="d">${c.afterHours} after hours · ${c.voicemails} voicemail${c.voicemails === 1 ? "" : "s"}</div></div>
      <div class="panel tile"><div class="k">Reply rate</div><div class="v">${pct(c.replyRate)}</div><div class="d">${c.replied} of ${c.missedCallers} callers</div></div>
      <div class="panel tile"><div class="k">Revenue won</div><div class="v">${money(c.wonCents)}</div><div class="d">${c.won} job${c.won === 1 ? "" : "s"} · ${vs(c.wonCents, p.wonCents, money)}</div></div>
    </div>
    <div class="grid cols-2">
      <section class="panel">
        <div class="row" style="justify-content:space-between;align-items:baseline">
          <h2>Missed calls and replies, by day</h2>
          <div class="legend"><span><i style="background:var(--s1)"></i>Missed calls</span><span><i style="background:var(--s2)"></i>Caller replied</span></div>
        </div>
        <div class="chart" id="chart"></div>
        <details class="tbl"><summary>Show as table</summary><table><thead><tr><th>Day</th><th>Missed</th><th>Replied</th></tr></thead><tbody>
          ${c.daily.map((r) => `<tr><td>${esc(r.date)}</td><td class="num">${r.missed}</td><td class="num">${r.replied}</td></tr>`).join("")}</tbody></table></details>
      </section>
      <section class="panel">
        <h2>Why calls were missed</h2>
        ${reasons.length ? bars(reasons.map(([k, n]) => [MISS[k], n])) : `<p class="muted" style="margin:0">No missed calls in this period.</p>`}
        <h2 style="margin-top:20px">Leads by stage (${c.newLeads} new)</h2>
        ${bars(STAGES.map((s) => [STAGE[s], c.stages[s]]))}
        <p class="muted small" style="margin:12px 0 0">At risk from missed callers: <b>${money(c.atRiskCents)}</b></p>
      </section>
    </div>
    <section class="panel" style="margin-top:14px">
      <h2>🚨 Urgent and waiting on you</h2>
      ${d.urgent.length ? d.urgent.map((l) => `<a class="item" href="#/inbox/${esc(l.id)}" style="border:0;border-top:1px solid var(--line)">
          <div class="top"><span class="who">#${l.code} ${esc(l.name || phone(l.phone))}</span><span class="muted small">${ago(activity(l))}</span></div>
          <div class="prev">${esc(l.job || "")}${l.address ? ` · 📍 ${esc(l.address)}` : ""}</div></a>`).join("") : `<p class="muted" style="margin:0">Nothing urgent right now.</p>`}
    </section>`;
  view.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
    RANGE = Number(b.dataset.r);
    store.set("tc_range", String(RANGE));
    renderDashboard();
  }));
  drawChart($("#chart"), c.daily);
}

function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return `<div class="bars">${rows.map(([label, n]) => `<div class="row"><span>${esc(label)}</span>
    <div class="track"><div class="fill" style="width:${(n / max) * 100}%"></div></div><span class="num" style="text-align:right">${n}</span></div>`).join("")}</div>`;
}

// Grouped bars, one y-axis; hover bands sit behind the bars.
function drawChart(el, daily) {
  const W = Math.max(300, Math.round(el.clientWidth || 640)), H = 220, L = 28, B = 24, T = 8;
  const max = Math.max(4, ...daily.map((d) => Math.max(d.missed, d.replied)));
  const step = Math.ceil(max / 4), top = step * 4, ph = H - B - T, gw = (W - L) / daily.length;
  const bw = Math.max(2, Math.min(18, (gw - 8) / 2));
  const y = (v) => T + ph - (v / top) * ph;
  const every = Math.ceil(daily.length / Math.max(4, Math.floor(W / 64)));
  const bar = (v, x, color) => {
    if (!v) return "";
    const h = Math.max(2, (v / top) * ph), yy = T + ph - h, r = Math.min(4, bw / 2, h);
    return `<path pointer-events="none" fill="${color}" d="M${x},${T + ph}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + bw - r}Q${x + bw},${yy} ${x + bw},${yy + r}V${T + ph}Z"/>`;
  };
  let grid = "", hits = "", marks = "";
  for (let i = 0; i <= 4; i++) grid += `<line x1="${L}" x2="${W}" y1="${y(step * i)}" y2="${y(step * i)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(step * i) + 4}" text-anchor="end">${step * i}</text>`;
  daily.forEach((d, i) => {
    const cx = L + gw * i + gw / 2;
    hits += `<rect class="hit" data-i="${i}" x="${L + gw * i}" y="${T}" width="${gw}" height="${ph}" fill="transparent"/>`;
    marks += bar(d.missed, cx - bw - 1, "var(--s1)") + bar(d.replied, cx + 1, "var(--s2)");
    if (i % every === 0 || i === daily.length - 1) {
      const dt = new Date(d.date + "T12:00:00Z");
      const lbl = daily.length <= 7 ? dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) : dt.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" });
      marks += `<text pointer-events="none" x="${cx}" y="${H - 6}" text-anchor="middle">${lbl}</text>`;
    }
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Missed calls and replies per day">${grid}${hits}${marks}</svg><div class="tip" hidden></div>`;
  const tip = $(".tip", el);
  el.querySelectorAll(".hit").forEach((r) => {
    r.addEventListener("mouseenter", () => {
      const d = daily[+r.dataset.i];
      const label = new Date(d.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
      tip.innerHTML = `<b>${label}</b><div><i style="background:var(--s1)"></i>Missed: ${d.missed}</div><div><i style="background:var(--s2)"></i>Replied: ${d.replied}</div>`;
      const k = el.querySelector("svg").getBoundingClientRect().width / W;
      tip.style.left = Math.min(Math.max((+r.getAttribute("x") + gw / 2) * k, 70), el.clientWidth - 70) + "px";
      tip.style.top = y(Math.max(d.missed, d.replied)) * k - 6 + "px";
      tip.hidden = false;
      r.setAttribute("fill", "var(--sunk)");
    });
    r.addEventListener("mouseleave", () => { tip.hidden = true; r.setAttribute("fill", "transparent"); });
  });
}

// ---------------- inbox ----------------

let FILTER = "OPEN", QUERY = "";

async function renderInbox(id) {
  const qs = new URLSearchParams({ stage: FILTER, ...(QUERY ? { q: QUERY } : {}) });
  const { leads } = await api(`/leads?${qs}`);
  const open = $("#open-count");
  if (FILTER === "OPEN" && !QUERY) {
    const n = leads.filter((l) => l.stage === "NEW" || l.stage === "ENGAGED").length;
    open.textContent = n;
    open.hidden = n === 0;
  }
  view.innerHTML = `
    <div class="head"><div><h1>Inbox</h1><p>Every caller and texter. Reply here, or just reply to the alert text on your phone.</p></div></div>
    <div class="inbox ${id ? "has-lead" : ""}">
      <section class="panel list">
        <div class="filters">
          <input id="q" placeholder="Search name, phone, job or #number" value="${esc(QUERY)}">
          <div class="chips" role="group" aria-label="Filter">${["OPEN", "ALL", ...STAGES].map((s) => `<button class="chip" data-f="${s}" aria-pressed="${s === FILTER}">${s === "OPEN" ? "Open" : s === "ALL" ? "All" : STAGE[s]}</button>`).join("")}</div>
        </div>
        <div class="items">${leads.length ? leads.map((l) => item(l, id)).join("") : `<div class="empty">No leads here yet. When you miss a call, the caller shows up here within seconds.</div>`}</div>
      </section>
      <section class="detail" id="detail">${id ? "" : `<div class="panel empty">Pick a lead to see the conversation.</div>`}</section>
    </div>`;
  view.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => { FILTER = b.dataset.f; renderInbox(id); }));
  const q = $("#q");
  q.addEventListener("input", () => {
    clearTimeout(renderInbox.t);
    renderInbox.t = setTimeout(async () => {
      QUERY = q.value.trim();
      await renderInbox(id);
      const n = $("#q");
      n.focus();
      n.setSelectionRange(n.value.length, n.value.length);
    }, 300);
  });
  if (id) await renderLead(id);
}

const activity = (l) => [l.lastInboundAt, l.lastOutboundAt, l.createdAt].filter(Boolean).sort().at(-1);

function item(l, current) {
  const last = l.last ? `${l.last.direction === "OUT" ? (l.last.kind === "OWNER" ? "You: " : "Auto: ") : ""}${l.last.body}` : l.job || "Missed call";
  const at = activity(l);
  return `<a class="item ${l.id === current ? "on" : ""}" href="#/inbox/${esc(l.id)}">
    <div class="top"><span class="who">#${l.code} ${esc(l.name || phone(l.phone))}</span><span class="muted small">${ago(at)}</span></div>
    <div class="prev">${esc(last)}</div>
    <div class="row"><span class="tag ${esc(l.stage)}">${STAGE[l.stage]}</span>${l.urgent ? `<span class="tag hot">Urgent</span>` : ""}${l.optedOut ? `<span class="tag stop">Opted out</span>` : ""}</div></a>`;
}

const KIND = { AUTO_REPLY: "Auto text-back", INTAKE: "Auto", NUDGE: "Auto follow-up", REMINDER: "Reminder", OWNER: "You" };

async function renderLead(id) {
  const box = $("#detail");
  const { lead, messages, calls, scheduled, earlierLeads } = await api(`/leads/${encodeURIComponent(id)}`);
  const timeline = [
    ...messages.map((m) => ({ at: m.createdAt, html: bubble(m) })),
    ...calls.map((c) => ({
      at: c.startedAt,
      html: `<div class="ev">📞 ${c.outcome === "ANSWERED" ? "Answered call" : `Missed call — ${esc(MISS[c.missReason] || "missed")}`}${c.afterHours ? " · after hours" : ""} · ${when(c.startedAt)}
        ${c.hasVoicemail ? `<audio controls preload="none" data-vm="${esc(c.id)}"></audio>` : ""}</div>`,
    })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  box.innerHTML = `
    <div class="panel">
      <div class="detail-head">
        <div><a href="#/inbox" class="small">← Inbox</a>
          <h1 style="margin-top:4px">#${lead.code} ${esc(lead.name || phone(lead.phone))}</h1>
          <div class="muted small"><a href="tel:${esc(lead.phone)}">${esc(phone(lead.phone))}</a> · since ${when(lead.createdAt)}${earlierLeads ? ` · ${earlierLeads} earlier job${earlierLeads > 1 ? "s" : ""}` : ""}</div></div>
        <div class="row">${lead.urgent ? `<span class="tag hot">Urgent</span>` : ""}${lead.optedOut ? `<span class="tag stop">Replied STOP</span>` : ""}<a class="btn alt" href="tel:${esc(lead.phone)}">📞 Call</a></div>
      </div>
      <div class="thread" id="thread">${timeline.map((t) => t.html).join("") || `<div class="ev">Nothing yet</div>`}</div>
      <form class="compose" id="send">
        <textarea name="body" maxlength="1200" required ${lead.optedOut ? "disabled" : ""} placeholder="${lead.optedOut ? "This customer opted out of texts" : "Text the customer…"}"></textarea>
        <button class="btn" ${lead.optedOut ? "disabled" : ""}>Send</button>
      </form>
      ${scheduled.length ? `<p class="muted small" style="margin:10px 0 0">Scheduled: ${scheduled.map((s) => `${s.type === "NUDGE" ? "follow-up" : "reminder"} ${when(s.runAt)}`).join(" · ")}</p>` : ""}
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-top:14px">
      <form class="panel" id="edit">
        <h2>Job details</h2>
        <label>Stage<select name="stage">${STAGES.map((s) => `<option value="${s}" ${s === lead.stage ? "selected" : ""}>${STAGE[s]}</option>`).join("")}</select></label>
        <label>Name<input name="name" maxlength="80" value="${esc(lead.name)}"></label>
        <label>Job<textarea name="job" maxlength="1000">${esc(lead.job)}</textarea></label>
        <label>Address<input name="address" maxlength="300" value="${esc(lead.address)}"></label>
        <label>Job value ($)<input name="value" type="number" min="0" step="1" value="${lead.valueCents != null ? lead.valueCents / 100 : ""}"><div class="hint">Add it when you win the job — it feeds "Revenue won".</div></label>
        <label class="check"><input type="checkbox" name="urgent" ${lead.urgent ? "checked" : ""}> Urgent</label>
        <label>Notes<textarea name="notes" maxlength="4000">${esc(lead.notes)}</textarea></label>
        <button class="btn">Save</button>
      </form>
      <form class="panel" id="appt">
        <h2>Appointment</h2>
        <label>Date & time (${esc(tz())})<input name="at" type="datetime-local" required value="${lead.appointmentAt ? toLocalInput(lead.appointmentAt) : ""}"></label>
        <div class="row"><button class="btn">${lead.appointmentAt ? "Reschedule" : "Book it"}</button>${lead.appointmentAt ? `<button type="button" class="btn danger" id="unbook">Cancel</button>` : ""}</div>
        <p class="hint">We text the customer a reminder 24 hours and 2 hours before — never between 9pm and 8am.</p>
      </form>
    </div>`;
  const th = $("#thread");
  th.scrollTop = th.scrollHeight;
  box.querySelectorAll("audio[data-vm]").forEach(async (a) => {
    try {
      const r = await fetch(`/api/calls/${a.dataset.vm}/voicemail`, { headers: { authorization: "Bearer " + store.get("tc_token") } });
      if (!r.ok) throw 0;
      a.src = URL.createObjectURL(await r.blob());
    } catch {
      a.replaceWith(Object.assign(document.createElement("span"), { textContent: " (voicemail unavailable)" }));
    }
  });
  $("#send").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button");
    btn.disabled = true;
    try {
      await api(`/leads/${lead.id}/messages`, { method: "POST", body: { body: ev.target.body.value } });
      await renderInbox(lead.id);
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  });
  $("#edit").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target, n = (v) => (v.trim() === "" ? null : v.trim());
    try {
      await api(`/leads/${lead.id}`, { method: "PATCH", body: {
        stage: f.stage.value, name: n(f.name.value), job: n(f.job.value), address: n(f.address.value), notes: n(f.notes.value),
        urgent: f.urgent.checked, value: f.value.value === "" ? null : Number(f.value.value),
      } });
      toast("Saved");
      await renderInbox(lead.id);
    } catch (e) { toast(e.message); }
  });
  $("#appt").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api(`/leads/${lead.id}/appointment`, { method: "PUT", body: { at: fromLocalInput(ev.target.at.value) } });
      toast("Booked — reminders scheduled");
      await renderInbox(lead.id);
    } catch (e) { toast(e.message); }
  });
  $("#unbook")?.addEventListener("click", async () => {
    await api(`/leads/${lead.id}/appointment`, { method: "DELETE" });
    toast("Appointment cancelled");
    await renderInbox(lead.id);
  });
}

function bubble(m) {
  const out = m.direction === "OUT";
  const bad = m.status === "failed";
  return `<div class="b ${out ? "out" : "in"}">${esc(m.body)}<small>${out ? esc(KIND[m.kind] || "") + " · " : ""}${when(m.createdAt)}${bad ? ` · <span style="color:var(--bad)">⚠ not delivered${m.error ? ": " + esc(m.error) : ""}</span>` : ""}</small></div>`;
}

// datetime-local is a wall-clock time; interpret it in the BUSINESS's timezone.
function offsetMs(date, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}
function fromLocalInput(v) {
  const [d, t] = v.split("T"), [Y, M, D] = d.split("-").map(Number), [h, m] = t.split(":").map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m);
  const first = guess - offsetMs(new Date(guess), tz());
  return new Date(guess - offsetMs(new Date(first), tz())).toISOString();
}
function toLocalInput(iso) {
  return new Date(new Date(iso).getTime() + offsetMs(new Date(iso), tz())).toISOString().slice(0, 16);
}

// ---------------- settings ----------------

async function renderSettings() {
  ME = await api("/me");
  const b = ME.business, hours = b.hours || {};
  const fwd = b.callMode === "FORWARDED";
  const num = b.phoneNumber ? phone(b.phoneNumber) : "your TradeCall number";
  const steps = [
    [ME.setup.hasNumber, "Get your TradeCall number", b.phoneNumber ? `Customers call and text <b>${esc(num)}</b>.` : "Search your area code below."],
    [ME.setup.selfTested, "Test the line", `Call ${esc(num)} from your own cell. You'll hear “your line is set up correctly”.`],
    [ME.setup.firstCustomerCall, fwd ? "Forward unanswered calls from your cell" : "Start using the number", fwd
      ? "Turn on your carrier's “forward when unanswered” to the TradeCall number (codes below). This ticks itself off when the first customer call comes through."
      : "Put it on your truck, Google profile and website. This ticks itself off when the first customer call comes through."],
  ];
  view.innerHTML = `
    <div class="head"><div><h1>Settings</h1><p>How calls reach you, and what customers get texted.</p></div></div>
    <div class="grid" style="gap:14px">
      <section class="panel">
        <h2>Setup</h2>
        <ol class="steps">${steps.map(([ok, t, d], i) => `<li><span class="dot ${ok ? "ok" : ""}">${ok ? "✓" : i + 1}</span><div><b>${t}</b><div class="muted small">${d}</div></div></li>`).join("")}</ol>
        ${b.phoneNumber ? "" : `<div class="row" style="margin-top:14px"><input id="area" placeholder="Area code, e.g. 512" maxlength="3" inputmode="numeric" style="max-width:190px"><button class="btn alt" id="find">Find numbers</button></div><div id="found" style="margin-top:8px"></div>`}
        <p class="hint" style="margin-top:14px">Provider: <b>${esc(ME.provider.name)}</b>${ME.provider.live ? ` · webhook <span class="code">${esc(ME.provider.webhookUrl)}</span>` : " (demo)"}</p>
      </section>

      <form class="panel" id="settings">
        <h2>Business</h2>
        <div class="fgrid">
          <label>Business name<input name="name" value="${esc(b.name)}" required></label>
          <label>Your first name (used in texts)<input name="ownerName" value="${esc(b.ownerName)}" required></label>
          <label>Your cell<input name="ownerPhone" value="${esc(phone(b.ownerPhone))}" required></label>
          <label>TradeCall number<input name="phoneNumber" value="${esc(b.phoneNumber ? phone(b.phoneNumber) : "")}" placeholder="Not connected"></label>
          <label>Timezone<input name="timezone" value="${esc(b.timezone)}" required></label>
          <label>Average job value ($)<input name="avgJob" type="number" min="0" value="${b.avgJobCents / 100}"><div class="hint">Used for "Jobs saved".</div></label>
        </div>

        <h2 style="margin-top:8px">Calls</h2>
        <label>How calls reach you<select name="callMode">
          <option value="RING_OWNER" ${b.callMode === "RING_OWNER" ? "selected" : ""}>Customers call my TradeCall number — ring my cell first</option>
          <option value="FORWARDED" ${b.callMode === "FORWARDED" ? "selected" : ""}>I keep my own number — my carrier forwards calls I don't answer</option>
        </select><div class="hint">Forwarding codes vary by carrier — commonly <span class="code">*71</span>+number (Verizon) or <span class="code">**61*</span>number<span class="code">#</span> (AT&amp;T, T-Mobile). Ask your carrier for "conditional call forwarding, no answer".</div></label>
        <div class="fgrid">
          <label>Ring my cell for (seconds)<input name="ringSeconds" type="number" min="10" max="45" value="${b.ringSeconds}"><div class="hint">Keep it shorter than your voicemail pickup (~20s).</div></label>
          <label>Don't re-text the same caller within (minutes)<input name="dedupeMin" type="number" min="0" max="1440" value="${b.dedupeMin}"></label>
        </div>
        <label class="check"><input type="checkbox" name="screenCalls" ${b.screenCalls ? "checked" : ""}><span>Make me press 1 to take a call<div class="hint">Without this, your own voicemail answering would count as "answered" and the caller would never get a text.</div></span></label>
        <label class="check"><input type="checkbox" name="voicemailEnabled" ${b.voicemailEnabled ? "checked" : ""}><span>Let callers leave a voicemail</span></label>

        <h2 style="margin-top:8px">Texts</h2>
        <label>Missed-call text (open hours)<textarea name="missedText" maxlength="480">${esc(b.missedText)}</textarea></label>
        <label>Missed-call text (closed)<textarea name="afterHoursText" maxlength="480">${esc(b.afterHoursText)}</textarea>
          <div class="hint">Use <span class="code">{business}</span> <span class="code">{owner}</span> <span class="code">{number}</span>. Keep "Reply STOP to opt out" in it.</div></label>
        <label class="check"><input type="checkbox" name="intakeEnabled" ${b.intakeEnabled ? "checked" : ""}><span>Ask 3 quick questions (job, address, emergency?) and text me a summary</span></label>
        <div class="row" style="margin-bottom:12px"><label class="check" style="margin:0"><input type="checkbox" name="nudgeEnabled" ${b.nudgeEnabled ? "checked" : ""}><span>Send one follow-up if they don't reply after</span></label>
          <input name="nudgeAfterMin" type="number" min="15" max="1440" value="${b.nudgeAfterMin}" style="width:90px"><span class="muted">minutes</span></div>
        <label class="check"><input type="checkbox" name="digestEnabled" ${b.digestEnabled ? "checked" : ""}><span>Text (and email) me a summary every Monday at 8am</span></label>

        <h2 style="margin-top:8px">Open hours</h2>
        <div class="hours"><span></span><span class="muted small">Open</span><span class="muted small">Close</span><span class="muted small">Closed</span>
          ${DAYS.map((d) => {
            const h = hours[d];
            return `<b style="text-transform:capitalize">${d}</b><input type="time" name="o_${d}" value="${h ? esc(h.open) : "08:00"}" ${h ? "" : "disabled"}><input type="time" name="c_${d}" value="${h ? esc(h.close) : "17:00"}" ${h ? "" : "disabled"}><input type="checkbox" name="x_${d}" ${h ? "" : "checked"} aria-label="Closed ${d}" style="width:auto">`;
          }).join("")}</div>
        <div class="err" id="serr"></div>
        <button class="btn">Save settings</button>
      </form>
    </div>`;

  $("#find")?.addEventListener("click", async () => {
    const out = $("#found");
    try {
      const { numbers } = await api(`/numbers/search?areaCode=${encodeURIComponent($("#area").value)}`);
      out.innerHTML = numbers.length ? numbers.map((n) => `<div class="row" style="margin:6px 0"><b class="num">${esc(phone(n.phoneNumber))}</b><span class="muted small">${esc([n.locality, n.region].filter(Boolean).join(", "))}</span><button class="btn alt" data-buy="${esc(n.phoneNumber)}">Use this number</button></div>`).join("")
        : `<p class="muted">Nothing available in that area code — try a neighbouring one.</p>`;
      out.querySelectorAll("[data-buy]").forEach((btn) => btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api("/numbers/buy", { method: "POST", body: { phoneNumber: btn.dataset.buy } });
          toast("Number connected 🎉");
          ME = null;
          route();
        } catch (e) { toast(e.message); btn.disabled = false; }
      }));
    } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  });

  const f = $("#settings");
  DAYS.forEach((d) => f[`x_${d}`].addEventListener("change", (e) => { f[`o_${d}`].disabled = f[`c_${d}`].disabled = e.target.checked; }));
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const hoursOut = {};
    DAYS.forEach((d) => (hoursOut[d] = f[`x_${d}`].checked ? null : { open: f[`o_${d}`].value, close: f[`c_${d}`].value }));
    try {
      await api("/settings", { method: "PATCH", body: {
        name: f.name.value, ownerName: f.ownerName.value, ownerPhone: f.ownerPhone.value, phoneNumber: f.phoneNumber.value.trim() || null,
        timezone: f.timezone.value.trim(), avgJob: Number(f.avgJob.value || 0), callMode: f.callMode.value, ringSeconds: Number(f.ringSeconds.value),
        dedupeMin: Number(f.dedupeMin.value), screenCalls: f.screenCalls.checked, voicemailEnabled: f.voicemailEnabled.checked,
        missedText: f.missedText.value, afterHoursText: f.afterHoursText.value, intakeEnabled: f.intakeEnabled.checked,
        nudgeEnabled: f.nudgeEnabled.checked, nudgeAfterMin: Number(f.nudgeAfterMin.value), digestEnabled: f.digestEnabled.checked, hours: hoursOut,
      } });
      $("#serr").textContent = "";
      toast("Saved");
      ME = null;
      route();
    } catch (e) { $("#serr").textContent = e.message; }
  });
}

route();
