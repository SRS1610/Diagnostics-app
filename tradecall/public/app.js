// TradeCall owner app — no build step. Everything from the API passes
// through esc() before it reaches innerHTML.
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const STAGES = ["NEW", "ENGAGED", "QUALIFIED", "SCHEDULED", "WON", "LOST"];
const STAGE = { NEW: "New", ENGAGED: "Replied", QUALIFIED: "Qualified", SCHEDULED: "Booked", WON: "Won", LOST: "Lost" };
const MISS = { NO_ANSWER: "Didn't pick up", CALLER_HUNG_UP: "Hung up while ringing", NOT_ACCEPTED: "Went to your voicemail", FORWARDED: "Forwarded by carrier" };
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
let ME = null; // tenant view: GET /me
let SESSION = null; // GET /session
const ROLE = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", PLATFORM_ADMIN: "Platform admin" };

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
const agoText = (iso) => (ago(iso) === "now" ? "just now" : `${ago(iso)} ago`);
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), 3200);
}

// A platform admin's support view uses its own short-lived token on top of
// their normal one; exiting just drops it.
const activeToken = () => store.get("tc_view") || store.get("tc_token");
function resetSession() {
  ME = null;
  SESSION = null;
}

async function api(path, { method = "GET", body } = {}) {
  const token = activeToken();
  const res = await fetch("/api" + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth")) {
    if (store.get("tc_view")) {
      store.set("tc_view", null); // support view expired: back to the console
      resetSession();
      location.hash = "#/platform";
    } else {
      store.set("tc_token", null);
      resetSession();
      location.hash = "#/login";
    }
    throw new Error(data.error || "Signed out");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------- routing ----------------

async function route() {
  const [, page = "dashboard", id] = (location.hash.replace(/^#/, "") || "/dashboard").split("/");
  const signedIn = Boolean(store.get("tc_token"));
  if (page === "invite") return showAuth(() => renderInvite(id));
  if (!signedIn || page === "login" || page === "signup") {
    if (signedIn) return (location.hash = "#/dashboard");
    return showAuth(() => renderAuth(page === "signup"));
  }
  $("#auth").hidden = true;
  $("#shell").hidden = false;
  try {
    if (!SESSION) SESSION = await api("/session");
    const platform = SESSION.user.role === "PLATFORM_ADMIN" && !SESSION.viewAs;
    document.body.classList.toggle("platform", platform);
    $("#tenant-nav").hidden = platform;
    $("#platform-nav").hidden = !platform;
    if (platform) return await platformRoute(page, id);
    if (!ME) ME = await api("/me");
  } catch {
    return;
  }
  $("#biz").textContent = ME.business.name;
  $("#biz-number").textContent = ME.business.phoneNumber ? phone(ME.business.phoneNumber) : "No number yet";
  const manager = ME.role === "OWNER" || ME.role === "ADMIN";
  document.querySelectorAll("[data-manager]").forEach((a) => (a.hidden = !manager));
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === page));
  supportBar();
  notice();
  try {
    if (page === "inbox") await renderInbox(id);
    else if (page === "leads" && id) location.hash = `#/inbox/${id}`; // links from alert texts
    else if (page === "team") await renderTeam();
    else if (page === "settings" && manager) await renderSettings();
    else await renderDashboard();
  } catch (e) {
    view.innerHTML = `<div class="panel err">${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
$("#signout").addEventListener("click", () => {
  store.set("tc_token", null);
  store.set("tc_view", null);
  resetSession();
  location.hash = "#/login";
});

function showAuth(render) {
  $("#shell").hidden = true;
  $("#auth").hidden = false;
  return render();
}

function supportBar() {
  const bar = $("#support-bar");
  if (!ME.viewAs) return (bar.hidden = true);
  bar.innerHTML = `<span>Support view of ${esc(ME.business.name)} — read-only, logged in their activity</span><button id="exit-view">Exit to console</button>`;
  bar.hidden = false;
  $("#exit-view").addEventListener("click", () => {
    store.set("tc_view", null);
    resetSession();
    location.hash = "#/platform/" + ME?.business?.id;
  });
}

function notice() {
  const n = $("#notice");
  n.classList.remove("bad");
  if (ME.business.status === "SUSPENDED") {
    n.classList.add("bad");
    n.textContent = `This account is suspended${ME.business.suspendedReason ? ` (${ME.business.suspendedReason})` : ""}. Calls and texts are paused and nothing can be changed — contact support.`;
  } else if (!ME.business.phoneNumber) {
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
      store.set("tc_view", null);
      resetSession();
      location.hash = signup ? "#/settings" : r.role === "PLATFORM_ADMIN" ? "#/platform" : "#/dashboard";
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
      ${planCard()}
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
          <label>TradeCall number<input value="${esc(b.phoneNumber ? phone(b.phoneNumber) : "Not connected yet")}" disabled><div class="hint">Get one under Setup above. Already have a number? Contact support to connect it.</div></label>
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
        name: f.name.value, ownerName: f.ownerName.value, ownerPhone: f.ownerPhone.value,
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

// ---------------- invites (public) ----------------

async function renderInvite(token) {
  const box = $("#auth");
  let info;
  try {
    info = await api(`/auth/invite/${encodeURIComponent(token || "")}`);
  } catch (e) {
    box.innerHTML = `<div class="panel auth-card"><div class="mark">TC</div><h1>Invite link problem</h1><p class="err">${esc(e.message)}</p><p class="small"><a href="#/login">Go to sign in</a></p></div>`;
    return;
  }
  box.innerHTML = `
    <div class="panel auth-card">
      <div class="mark">TC</div>
      <h1>Join ${esc(info.businessName)}</h1>
      <p class="muted" style="margin:6px 0 18px">You've been added as <b>${esc(ROLE[info.role])}</b>. Set up your login for <b>${esc(info.email)}</b>.</p>
      <form id="f">
        <label>Your name<input name="name" required maxlength="60" autocomplete="name"></label>
        <label>Your cell (optional)<input name="phone" type="tel" autocomplete="tel" placeholder="(555) 123-4567">
          <div class="hint">Add it to get lead alerts by text and reply to customers from your phone.</div></label>
        <label>Choose a password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
        <div class="err" id="e"></div>
        <button class="btn" style="width:100%">Join the team</button>
      </form>
    </div>`;
  $("#f").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    if (!body.phone) delete body.phone;
    try {
      const r = await api(`/auth/invite/${encodeURIComponent(token)}/accept`, { method: "POST", body });
      store.set("tc_token", r.token);
      store.set("tc_view", null);
      resetSession();
      location.hash = "#/inbox";
    } catch (e) {
      $("#e").textContent = e.message;
    }
  });
}

// ---------------- plan & usage ----------------

function planCard() {
  const p = ME.plan, t = p.texts;
  const pctUsed = Math.min(100, Math.round((t.sent / Math.max(1, t.included)) * 100));
  return `<section class="panel">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">Plan: ${esc(p.label)}</h2><span class="muted small">Contact us to change plan</span></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-top:10px">
      <div><div class="small muted">Texts this month</div><div class="meter ${t.overage ? "over" : ""}"><div style="width:${pctUsed}%"></div></div>
        <div class="small"><b class="num">${t.sent.toLocaleString()}</b> of ${t.included.toLocaleString()} included${t.overage ? ` · <b>${t.overage.toLocaleString()} over</b> (billed as overage)` : ""}</div></div>
      <div><div class="small muted">Team seats</div><div class="meter"><div style="width:${Math.round((p.seats.used / p.seats.limit) * 100)}%"></div></div>
        <div class="small"><b class="num">${p.seats.used}</b> of ${p.seats.limit} used (includes pending invites)</div></div>
    </div></section>`;
}

// ---------------- team ----------------

const ACTION = {
  login: "signed in", tenant_created: "created the account", invite_sent: "invited", invite_revoked: "cancelled the invite for",
  invite_accepted: "joined the team", member_updated: "updated team member", password_changed: "changed their password",
  settings_updated: "changed settings", number_purchased: "connected number", lead_updated: "updated lead",
  tenant_suspended: "suspended the account", tenant_reactivated: "reactivated the account", tenant_updated: "changed plan/settings for",
  support_view_opened: "opened a read-only support view of",
};
function activityRow(e, withBusiness = false) {
  const details = e.details ? Object.entries(e.details).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map((x) => x ?? "—").join(" → ") : typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ") : "";
  return `<tr><td class="muted small">${new Date(e.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
    ${withBusiness ? `<td>${esc(e.businessName || "—")}</td>` : ""}
    <td class="wrap"><b>${esc(e.actorName)}</b>${e.actorKind === "PLATFORM" ? ` <span class="tag">TradeCall staff</span>` : ""} ${esc(ACTION[e.action] || e.action)} ${esc(e.target || "")}
    ${details ? `<div class="muted small">${esc(details)}</div>` : ""}</td></tr>`;
}

async function renderTeam() {
  const [team, activity] = await Promise.all([
    api("/team"),
    ME.role === "OWNER" || ME.role === "ADMIN" ? api("/activity") : Promise.resolve(null),
  ]);
  const meId = ME.user.id;
  const ownerOnly = ME.role === "OWNER";
  const roleOptions = (cur, disabled) => `<select class="compact" data-role ${disabled ? "disabled" : ""}>${["OWNER", "ADMIN", "MEMBER"]
    .filter((r) => r !== "OWNER" || ownerOnly || cur === "OWNER").map((r) => `<option value="${r}" ${r === cur ? "selected" : ""}>${ROLE[r]}</option>`).join("")}</select>`;
  view.innerHTML = `
    <div class="head"><div><h1>Team</h1><p>Who can use TradeCall for ${esc(ME.business.name)}, and who gets lead alerts by text.</p></div>
      <div class="muted small">${team.seats.used} of ${team.seats.limit} seats used</div></div>
    <div class="grid" style="gap:14px">
      <section class="panel"><div class="tbl-wrap"><table class="list">
        <thead><tr><th>Name</th><th>Role</th><th>Alert phone</th><th>Alerts</th><th>Last sign-in</th>${team.canManage ? "<th></th>" : ""}</tr></thead>
        <tbody>${team.users.map((u) => {
          const self = u.id === meId, locked = !team.canManage || self || (u.role === "OWNER" && !ownerOnly);
          return `<tr data-user="${esc(u.id)}" style="${u.active ? "" : "opacity:.55"}">
            <td><b>${esc(u.name)}</b>${self ? ' <span class="muted small">(you)</span>' : ""}<div class="muted small">${esc(u.email)}</div></td>
            <td>${team.canManage ? roleOptions(u.role, locked) : `<span class="tag role">${ROLE[u.role]}</span>`}</td>
            <td>${team.canManage && !(u.role === "OWNER" && !ownerOnly) ? `<input class="compact" data-phone value="${esc(u.phone ? phone(u.phone) : "")}" placeholder="none" style="width:140px">` : esc(u.phone ? phone(u.phone) : "—")}</td>
            <td><input type="checkbox" data-alerts ${u.getsAlerts ? "checked" : ""} ${team.canManage && !(u.role === "OWNER" && !ownerOnly) ? "" : "disabled"} aria-label="Alerts for ${esc(u.name)}"></td>
            <td class="muted small">${u.active ? (u.lastLoginAt ? agoText(u.lastLoginAt) : "never") : "Removed"}</td>
            ${team.canManage ? `<td>${locked ? "" : `<button class="btn alt" data-toggle>${u.active ? "Remove" : "Restore"}</button>`}</td>` : ""}
          </tr>`;
        }).join("")}</tbody></table></div>
        <p class="hint">Everyone with alerts on gets new-lead and voicemail texts, and can reply to them to text the customer.</p>
      </section>

      ${team.canManage ? `<section class="panel">
        <h2>Invite someone</h2>
        <form id="invite" class="row" style="align-items:flex-end">
          <label style="flex:1;min-width:220px;margin:0">Email<input name="email" type="email" required></label>
          <label style="margin:0">Role<select name="role">${["MEMBER", "ADMIN", ...(ownerOnly ? ["OWNER"] : [])].map((r) => `<option value="${r}">${ROLE[r]}</option>`).join("")}</select></label>
          <button class="btn">Send invite</button>
        </form>
        <div id="invite-out"></div>
        <p class="hint">Members work the inbox. Admins can also change settings and the team. Owners can do everything.</p>
        ${team.invites.length ? `<h2 style="margin-top:16px">Waiting to join</h2><div class="tbl-wrap"><table class="list"><tbody>${team.invites.map((i) => `<tr>
          <td>${esc(i.email)}</td><td><span class="tag role">${ROLE[i.role]}</span></td><td class="muted small">expires ${when(i.expiresAt, { hour: undefined, minute: undefined })}</td>
          <td><button class="btn danger" data-revoke="${esc(i.id)}">Cancel</button></td></tr>`).join("")}</tbody></table></div>` : ""}
      </section>` : ""}

      <form class="panel" id="profile">
        <h2>Your profile</h2>
        <div class="fgrid">
          <label>Name<input name="name" value="${esc(ME.user.name)}" required maxlength="60"></label>
          <label>Your cell<input name="phone" value="${esc(ME.user.phone ? phone(ME.user.phone) : "")}" placeholder="for alerts and SMS replies"></label>
        </div>
        <label class="check"><input type="checkbox" name="getsAlerts" ${ME.user.getsAlerts ? "checked" : ""}><span>Text me new leads and voicemails</span></label>
        <div class="fgrid">
          <label>Current password<input name="currentPassword" type="password" autocomplete="current-password"></label>
          <label>New password<input name="newPassword" type="password" minlength="8" autocomplete="new-password"></label>
        </div>
        <button class="btn">Save profile</button>
      </form>

      ${activity ? `<section class="panel"><h2>Activity</h2>
        ${activity.entries.length ? `<div class="tbl-wrap"><table class="list"><tbody>${activity.entries.map((e) => activityRow(e)).join("")}</tbody></table></div>` : `<p class="muted">Nothing yet.</p>`}
      </section>` : ""}
    </div>`;

  const patchUser = async (row, body) => {
    try {
      await api(`/team/${row.dataset.user}`, { method: "PATCH", body });
      toast("Saved");
    } catch (e) {
      toast(e.message);
    }
    renderTeam();
  };
  view.querySelectorAll("tr[data-user]").forEach((row) => {
    row.querySelector("[data-role]")?.addEventListener("change", (e) => patchUser(row, { role: e.target.value }));
    row.querySelector("[data-alerts]")?.addEventListener("change", (e) => patchUser(row, { getsAlerts: e.target.checked }));
    row.querySelector("[data-phone]")?.addEventListener("change", (e) => patchUser(row, { phone: e.target.value.trim() || null }));
    row.querySelector("[data-toggle]")?.addEventListener("click", (e) => patchUser(row, { active: e.target.textContent === "Restore" }));
  });
  view.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
    try { await api(`/team/invites/${b.dataset.revoke}`, { method: "DELETE" }); } catch (e) { toast(e.message); }
    ME = null; ME = await api("/me");
    renderTeam();
  }));
  $("#invite")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api("/team/invites", { method: "POST", body: Object.fromEntries(new FormData(ev.target)) });
      ME = await api("/me");
      await renderTeam();
      $("#invite-out").innerHTML = `<p class="small" style="margin:10px 0 0">${r.emailed ? "Invite emailed. " : ""}Or send them this link (expires in 7 days):</p>
        <div class="linkbox"><input readonly value="${esc(r.link)}"><button class="btn alt" id="copy">Copy</button></div>`;
      $("#copy").addEventListener("click", () => navigator.clipboard?.writeText(r.link).then(() => toast("Link copied"), () => {}));
    } catch (e) {
      toast(e.message);
    }
  });
  $("#profile").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const body = { name: f.name.value, phone: f.phone.value.trim() || null, getsAlerts: f.getsAlerts.checked };
    if (f.newPassword.value) Object.assign(body, { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value });
    try {
      await api("/me", { method: "PATCH", body });
      ME = await api("/me");
      toast("Profile saved");
      renderTeam();
    } catch (e) {
      toast(e.message);
    }
  });
}

// ---------------- platform console ----------------

const PLAN = { STARTER: "Starter", PRO: "Pro", TEAM: "Team" };

async function platformRoute(page, id) {
  $("#biz").innerHTML = `TradeCall <span class="console-tag">Platform console</span>`;
  $("#biz-number").textContent = SESSION.user.name;
  $("#notice").hidden = true;
  $("#support-bar").hidden = true;
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === (page === "platform-activity" ? page : "platform")));
  try {
    if (page === "platform" && id === "new") await renderNewTenant();
    else if (page === "platform" && id) await renderTenant(id);
    else if (page === "platform-activity") await renderPlatformActivity();
    else await renderPlatform();
  } catch (e) {
    view.innerHTML = `<div class="panel err">${esc(e.message)}</div>`;
  }
}

let PQ = "", PSTATUS = "";
async function renderPlatform() {
  const qs = new URLSearchParams({ ...(PQ ? { q: PQ } : {}), ...(PSTATUS ? { status: PSTATUS } : {}) });
  const [o, { tenants }] = await Promise.all([api("/platform/overview"), api(`/platform/tenants?${qs}`)]);
  view.innerHTML = `
    <div class="head"><div><h1>Businesses</h1><p>Every company on TradeCall. Changes here are logged in that business's own activity.</p></div>
      <a class="btn" href="#/platform/new">+ New business</a></div>
    <div class="grid tiles">
      <div class="panel tile"><div class="k">Active businesses</div><div class="v">${o.tenants.ACTIVE || 0}</div><div class="d">${Object.entries(o.activeByPlan).map(([k, n]) => `${n} ${PLAN[k]}`).join(" · ") || "—"}</div></div>
      <div class="panel tile"><div class="k">Suspended</div><div class="v">${o.tenants.SUSPENDED || 0}</div><div class="d">service paused</div></div>
      <div class="panel tile"><div class="k">Texts this month</div><div class="v">${o.textsThisMonth.toLocaleString()}</div><div class="d">all businesses</div></div>
      <div class="panel tile"><div class="k">Missed calls (30d)</div><div class="v">${o.missedCalls30d.toLocaleString()}</div><div class="d">all businesses</div></div>
    </div>
    <section class="panel">
      <div class="row" style="margin-bottom:10px">
        <input id="pq" placeholder="Search name, email or number" value="${esc(PQ)}" style="max-width:320px">
        <div class="chips">${[["", "All"], ["ACTIVE", "Active"], ["SUSPENDED", "Suspended"]].map(([v, l]) => `<button class="chip" data-st="${v}" aria-pressed="${v === PSTATUS}">${l}</button>`).join("")}</div>
      </div>
      <div class="tbl-wrap"><table class="list">
        <thead><tr><th>Business</th><th>Status</th><th>Plan</th><th>Number</th><th>Users</th><th>Texts (month)</th><th>Missed 30d</th><th>Last call</th></tr></thead>
        <tbody>${tenants.map((t) => `<tr class="link" data-t="${esc(t.id)}">
          <td><b>${esc(t.name)}</b><div class="muted small">${esc(t.email)}</div></td>
          <td><span class="tag ${t.status}">${t.status === "ACTIVE" ? "Active" : "Suspended"}</span></td>
          <td>${PLAN[t.plan]}</td><td class="num">${esc(t.phoneNumber ? phone(t.phoneNumber) : "—")}</td>
          <td class="num">${t.activeUsers}/${t.seats}</td>
          <td class="num">${t.textsThisMonth.toLocaleString()}<span class="muted small"> / ${t.includedTexts.toLocaleString()}</span>${t.textsThisMonth > t.includedTexts ? ' <span class="tag NEW">over</span>' : ""}</td>
          <td class="num">${t.missedCalls30d}</td><td class="muted small">${t.lastCallAt ? agoText(t.lastCallAt) : "—"}</td></tr>`).join("") || `<tr><td colspan="8" class="muted">No businesses match.</td></tr>`}</tbody>
      </table></div>
    </section>`;
  view.querySelectorAll("[data-t]").forEach((r) => r.addEventListener("click", () => (location.hash = `#/platform/${r.dataset.t}`)));
  view.querySelectorAll("[data-st]").forEach((b) => b.addEventListener("click", () => { PSTATUS = b.dataset.st; renderPlatform(); }));
  const q = $("#pq");
  q.addEventListener("input", () => {
    clearTimeout(renderPlatform.t);
    renderPlatform.t = setTimeout(async () => {
      PQ = q.value.trim();
      await renderPlatform();
      const n = $("#pq");
      n.focus();
      n.setSelectionRange(n.value.length, n.value.length);
    }, 300);
  });
}

async function renderTenant(id) {
  const { tenant: t, users, invites, activity } = await api(`/platform/tenants/${encodeURIComponent(id)}`);
  view.innerHTML = `
    <p><a href="#/platform" class="small">← All businesses</a></p>
    <div class="head"><div><h1>${esc(t.name)} <span class="tag ${t.status}">${t.status === "ACTIVE" ? "Active" : "Suspended"}</span></h1>
      <p>${esc(t.email)} · ${esc(t.phoneNumber ? phone(t.phoneNumber) : "no number")} · since ${new Date(t.createdAt).toLocaleDateString()}</p></div>
      <button class="btn" id="view-as">Open read-only support view</button></div>
    ${t.status === "SUSPENDED" ? `<div class="panel" style="background:var(--bad-bg);color:var(--bad);border-color:transparent;margin-bottom:14px">Suspended: ${esc(t.suspendedReason || "")}</div>` : ""}
    <div class="grid tiles">
      <div class="panel tile"><div class="k">Texts this month</div><div class="v">${t.textsThisMonth}</div><div class="d">of ${t.includedTexts} included</div></div>
      <div class="panel tile"><div class="k">Missed calls (30d)</div><div class="v">${t.missedCalls30d}</div><div class="d">${t.leads30d} leads</div></div>
      <div class="panel tile"><div class="k">Users</div><div class="v">${t.activeUsers}</div><div class="d">of ${t.seats} seats</div></div>
    </div>
    <div class="grid cols-2">
      <section class="panel">
        <h2>Account</h2>
        <form id="tform">
          <div class="fgrid">
            <label>Business name<input name="name" value="${esc(t.name)}" required maxlength="80"></label>
            <label>Contact / billing email<input name="email" type="email" value="${esc(t.email)}" required></label>
            <label>Plan<select name="plan">${Object.entries(PLAN).map(([k, l]) => `<option value="${k}" ${k === t.plan ? "selected" : ""}>${l}</option>`).join("")}</select></label>
            <label>Telnyx messaging profile<input name="messagingProfileId" value="${esc(t.messagingProfileId || "")}" placeholder="platform default">
              <div class="hint">Set once this business's 10DLC brand + campaign is approved.</div></label>
            <label>Business number<input name="phoneNumber" value="${esc(t.phoneNumber ? phone(t.phoneNumber) : "")}" placeholder="none">
              <div class="hint">For a number already in your Telnyx account. Must be on your Call Control app.</div></label>
          </div>
          <button class="btn alt">Save account changes</button>
        </form>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
          ${t.status === "ACTIVE"
            ? `<form id="suspend" class="row" style="align-items:flex-end"><label style="flex:1;min-width:220px;margin:0">Reason (shown to the business)<input name="reason" required minlength="3" maxlength="300"></label><button class="btn danger">Suspend service</button></form>`
            : `<button class="btn" id="reactivate">Reactivate service</button>`}
        </div>
      </section>
      <section class="panel"><h2>Users</h2>
        ${users.length ? `<div class="tbl-wrap"><table class="list"><tbody>${users.map((u) => `<tr><td><b>${esc(u.name)}</b><div class="muted small">${esc(u.email)}</div></td><td><span class="tag role">${ROLE[u.role]}</span></td><td class="muted small">${u.active ? (u.lastLoginAt ? agoText(u.lastLoginAt) : "never signed in") : "removed"}</td></tr>`).join("")}</tbody></table></div>`
          : `<p class="muted" style="margin:0">Nobody has joined yet.</p>`}
        ${invites.length ? `<h2 style="margin-top:16px">Waiting to join</h2><div class="tbl-wrap"><table class="list"><tbody>${invites.map((i) => `<tr><td class="wrap">${esc(i.email)} <span class="tag role">${ROLE[i.role]}</span>
          <div class="muted small">link expires ${new Date(i.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div></td><td style="text-align:right"><button class="btn danger" data-cancel="${esc(i.id)}">Cancel</button></td></tr>`).join("")}</tbody></table></div>` : ""}
        <h2 style="margin-top:16px">Invite someone</h2>
        <form id="pinvite" class="row" style="align-items:flex-end">
          <label style="flex:1;min-width:180px;margin:0">Email<input name="email" type="email" required></label>
          <label style="margin:0">Role<select name="role">${["OWNER", "ADMIN", "MEMBER"].map((r) => `<option value="${r}">${ROLE[r]}</option>`).join("")}</select></label>
          <button class="btn alt">Send invite</button>
        </form>
        <div id="pinvite-out"></div>
        <p class="hint">Re-inviting the same email replaces their old link — use this when an owner lost theirs.</p>
      </section>
    </div>
    <section class="panel" style="margin-top:14px"><h2>Activity</h2>
      ${activity.length ? `<div class="tbl-wrap"><table class="list"><tbody>${activity.map((e) => activityRow(e)).join("")}</tbody></table></div>` : `<p class="muted">Nothing yet.</p>`}</section>`;

  $("#tform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api(`/platform/tenants/${t.id}`, { method: "PATCH", body: { name: f.name.value.trim(), email: f.email.value.trim(), plan: f.plan.value, messagingProfileId: f.messagingProfileId.value.trim() || null, phoneNumber: f.phoneNumber.value.trim() || null } });
      toast("Saved");
      renderTenant(t.id);
    } catch (e) { toast(e.message); }
  });
  $("#suspend")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!confirm(`Suspend ${t.name}? Their calls won't be answered and no texts will go out until you reactivate.`)) return;
    try { await api(`/platform/tenants/${t.id}/suspend`, { method: "POST", body: { reason: ev.target.reason.value } }); renderTenant(t.id); } catch (e) { toast(e.message); }
  });
  $("#reactivate")?.addEventListener("click", async () => {
    try { await api(`/platform/tenants/${t.id}/reactivate`, { method: "POST" }); renderTenant(t.id); } catch (e) { toast(e.message); }
  });
  view.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", async () => {
    try { await api(`/platform/tenants/${t.id}/invites/${b.dataset.cancel}`, { method: "DELETE" }); renderTenant(t.id); } catch (e) { toast(e.message); }
  }));
  $("#pinvite").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api(`/platform/tenants/${t.id}/invites`, { method: "POST", body: Object.fromEntries(new FormData(ev.target)) });
      await renderTenant(t.id);
      $("#pinvite-out").innerHTML = inviteLinkBox(r);
      bindCopy(r.link);
    } catch (e) { toast(e.message); }
  });
  $("#view-as").addEventListener("click", async () => {
    try {
      const r = await api(`/platform/tenants/${t.id}/view-as`, { method: "POST" });
      store.set("tc_view", r.token);
      resetSession();
      location.hash = "#/dashboard";
    } catch (e) { toast(e.message); }
  });
}

async function renderPlatformActivity() {
  const { entries } = await api("/platform/activity");
  view.innerHTML = `<div class="head"><div><h1>Activity</h1><p>The latest 100 events across every business.</p></div></div>
    <section class="panel"><div class="tbl-wrap"><table class="list"><thead><tr><th>When</th><th>Business</th><th>What happened</th></tr></thead>
    <tbody>${entries.map((e) => activityRow(e, true)).join("")}</tbody></table></div></section>`;
}


function inviteLinkBox(r) {
  return `<p class="small" style="margin:10px 0 0">${r.emailed ? "Invite emailed. " : "Email isn't set up on the server, so send them this link yourself. "}The link works once and expires in 7 days:</p>
    <div class="linkbox"><input readonly value="${esc(r.link)}"><button type="button" class="btn alt" id="copy">Copy</button></div>`;
}
function bindCopy(link) {
  $("#copy")?.addEventListener("click", () => navigator.clipboard?.writeText(link).then(() => toast("Link copied"), () => toast("Couldn't copy — select the link and copy it")));
}

async function renderNewTenant() {
  const zones = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = zones.includes(mine) ? mine : "America/New_York";
  view.innerHTML = `
    <p><a href="#/platform" class="small">← All businesses</a></p>
    <div class="head"><div><h1>New business</h1><p>Set up an account for a customer. Their owner gets an invite to set their own password — you never see it.</p></div></div>
    <form class="panel" id="newt" style="max-width:720px">
      <div class="fgrid">
        <label>Business name<input name="businessName" required maxlength="80" placeholder="Peak Roofing"></label>
        <label>Plan<select name="plan">${Object.entries(PLAN).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
        <label>Owner's first name<input name="ownerName" required maxlength="60"><div class="hint">Used in their customer texts ("Ray will call you back").</div></label>
        <label>Owner's email<input name="ownerEmail" type="email" required><div class="hint">Their login, and where the invite goes.</div></label>
        <label>Owner's cell<input name="ownerPhone" type="tel" required placeholder="(555) 123-4567"><div class="hint">Rings first when customers call.</div></label>
        <label>Timezone<select name="timezone">${zones.map((z) => `<option ${z === zone ? "selected" : ""}>${esc(z)}</option>`).join("")}</select></label>
      </div>
      <div class="err" id="nerr"></div>
      <button class="btn">Create business and invite owner</button>
      <p class="hint">Next: get them a number (from their Settings, or assign one you already own on the business's page) and register their 10DLC brand in Telnyx.</p>
    </form>`;
  $("#newt").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button");
    btn.disabled = true;
    try {
      const r = await api("/platform/tenants", { method: "POST", body: Object.fromEntries(new FormData(ev.target)) });
      location.hash = `#/platform/${r.tenant.id}`;
      // Show the owner's invite link once the business page has rendered.
      let tries = 0;
      const show = () => {
        const out = $("#pinvite-out");
        if (!out) return ++tries < 100 && setTimeout(show, 50);
        out.innerHTML = inviteLinkBox(r);
        bindCopy(r.link);
        toast(`${r.tenant.name} created`);
      };
      show();
    } catch (e) {
      $("#nerr").textContent = e.message;
      btn.disabled = false;
    }
  });
}
