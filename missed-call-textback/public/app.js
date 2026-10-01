// Owner dashboard — plain JS, no build step. Every value from the API is
// escaped through esc() before it touches innerHTML.
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "BOOKED", "WON", "LOST"];
const STATUS_LABEL = { NEW: "New", CONTACTED: "Replied", QUALIFIED: "Qualified", BOOKED: "Booked", WON: "Won", LOST: "Lost" };
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

let me = null; // { business, setup }

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function token() {
  try { return localStorage.getItem("tb_token"); } catch { return null; }
}
function setToken(t) {
  try { t ? localStorage.setItem("tb_token", t) : localStorage.removeItem("tb_token"); } catch { /* private mode */ }
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3200);
}
function phone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || "";
}
function money(cents) {
  return "$" + Math.round((cents || 0) / 100).toLocaleString("en-US");
}
function pct(x) {
  return x === null || x === undefined ? "–" : Math.round(x * 100) + "%";
}
function tz() {
  return me?.business?.timezone || undefined;
}
function when(iso, opts = {}) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz(), month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...opts }).format(new Date(iso));
}
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", ...(token() ? { authorization: "Bearer " + token() } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth")) {
    setToken(null);
    location.hash = "#/login";
    throw new Error(data.error || "Signed out");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- routing ----------

async function route() {
  const hash = location.hash.replace(/^#/, "") || "/dashboard";
  const [, page, id] = hash.split("/");
  const authed = Boolean(token());
  $("#topbar").hidden = !authed || page === "login" || page === "signup";
  if (!authed && page !== "signup") return renderAuth("login");
  if (page === "login" || page === "signup") return authed ? (location.hash = "#/dashboard") : renderAuth(page);

  if (!me) {
    try {
      me = await api("/me");
    } catch (e) {
      return;
    }
  }
  $("#biz-name").textContent = me.business.name;
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
  renderBanner();

  try {
    if (page === "leads" && id) await renderLead(id);
    else if (page === "leads") await renderLeads();
    else if (page === "settings") await renderSettings();
    else await renderDashboard();
  } catch (e) {
    view.innerHTML = `<div class="card error">${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
$("#logout").addEventListener("click", () => {
  setToken(null);
  me = null;
  location.hash = "#/login";
});

function renderBanner() {
  const b = $("#setup-banner");
  if (!me.business.twilioNumber) {
    b.innerHTML = `No phone number connected yet — missed calls can't be texted back. <a href="#/settings">Set one up →</a>`;
    b.hidden = false;
  } else if (!me.setup.twilioConfigured) {
    b.textContent = "Demo mode: Twilio credentials aren't configured on the server, so texts are recorded but not actually sent.";
    b.hidden = false;
  } else b.hidden = true;
}

// ---------- auth ----------

function renderAuth(mode) {
  const signup = mode === "signup";
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  view.innerHTML = `
    <div class="auth card">
      <h1>${signup ? "Stop losing jobs to voicemail" : "Sign in"}</h1>
      <p class="sub">${signup ? "Every missed call gets an instant text back, so the customer talks to you — not the next plumber on Google." : "Missed-call text-back dashboard"}</p>
      <form id="auth-form">
        ${signup ? `
          <label>Business name<input name="businessName" required maxlength="80" autocomplete="organization"></label>
          <label>Your first name<input name="ownerName" required maxlength="60" autocomplete="given-name"></label>
          <label>Your cell phone<input name="ownerPhone" required type="tel" autocomplete="tel" placeholder="(555) 123-4567">
            <div class="hint">Lead alerts go here, and it's the phone we ring first.</div></label>` : ""}
        <label>Email<input name="email" required type="email" autocomplete="email"></label>
        <label>Password<input name="password" required type="password" minlength="${signup ? 8 : 1}" autocomplete="${signup ? "new-password" : "current-password"}"></label>
        <div class="error" id="auth-error"></div>
        <button class="btn" style="width:100%">${signup ? "Create account" : "Sign in"}</button>
      </form>
      <p class="muted" style="margin-top:14px;text-align:center">
        ${signup ? `Have an account? <a href="#/login">Sign in</a>` : `New here? <a href="#/signup">Create an account</a>`}</p>
    </div>`;
  $("#auth-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    if (signup) body.timezone = zone;
    try {
      const res = await api(signup ? "/auth/signup" : "/auth/login", { method: "POST", body });
      setToken(res.token);
      me = null;
      location.hash = signup ? "#/settings" : "#/dashboard";
    } catch (e) {
      $("#auth-error").textContent = e.message;
    }
  });
}

// ---------- dashboard ----------

let dashDays = 7;

function delta(cur, prev, fmt = (x) => x) {
  if (prev === null || prev === undefined) return "";
  const diff = cur - prev;
  if (diff === 0) return `same as previous ${dashDays} days`;
  return `${diff > 0 ? "▲" : "▼"} ${fmt(Math.abs(diff))} vs previous ${dashDays} days`;
}

async function renderDashboard() {
  const d = await api(`/dashboard?days=${dashDays}`);
  const c = d.current, p = d.previous;
  view.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:16px">
      <div><h1>Your week at a glance</h1><p class="sub" style="margin:0">Last ${dashDays} days · ${esc(me.business.timezone)}</p></div>
      <div class="chips" role="group" aria-label="Date range">
        ${[7, 30, 90].map((n) => `<button class="chip" data-days="${n}" aria-pressed="${n === dashDays}">${n} days</button>`).join("")}
      </div>
    </div>

    <div class="grid kpis">
      <div class="card kpi hero">
        <div class="label">Pipeline saved</div>
        <div class="value">${money(c.pipelineRecoveredCents)}</div>
        <div class="delta">${c.repliedLeads} replies × ${money(d.avgJobValueCents)} avg job</div>
      </div>
      <div class="card kpi">
        <div class="label">Missed calls</div>
        <div class="value">${c.missedCalls}</div>
        <div class="delta">${c.afterHoursMissed} after hours · ${delta(c.missedCalls, p.missedCalls)}</div>
      </div>
      <div class="card kpi">
        <div class="label">Texted back</div>
        <div class="value">${c.textBacksSent}</div>
        <div class="delta">${c.totalCalls ? Math.round((c.answeredCalls / c.totalCalls) * 100) + "% of calls answered live" : "no calls yet"}</div>
      </div>
      <div class="card kpi">
        <div class="label">Reply rate</div>
        <div class="value">${pct(c.replyRate)}</div>
        <div class="delta">${c.repliedLeads} of ${c.missedCallers} callers replied</div>
      </div>
      <div class="card kpi">
        <div class="label">Revenue won</div>
        <div class="value">${money(c.revenueWonCents)}</div>
        <div class="delta">${c.wonJobs} job${c.wonJobs === 1 ? "" : "s"} · ${delta(c.revenueWonCents, p.revenueWonCents, money)}</div>
      </div>
    </div>

    <div class="grid two">
      <div class="card">
        <div class="chart-head">
          <h2>Missed calls vs. callers who replied</h2>
          <div class="legend"><span><i style="background:var(--series-1)"></i>Missed calls</span><span><i style="background:var(--series-2)"></i>Replied to text</span></div>
        </div>
        <div class="chart" id="daily-chart"></div>
        <details class="table-view"><summary>Show as table</summary>
          <table><thead><tr><th>Day</th><th>Missed</th><th>Replied</th></tr></thead><tbody>
          ${c.daily.map((r) => `<tr><td>${esc(r.date)}</td><td class="num">${r.missed}</td><td class="num">${r.replied}</td></tr>`).join("")}
          </tbody></table></details>
      </div>
      <div class="card">
        <h2>Leads this period (${c.newLeads})</h2>
        ${funnel(c.funnel)}
        <p class="muted" style="font-size:12.5px;margin:12px 0 0">Money at risk from missed callers: <b>${money(c.revenueAtRiskCents)}</b></p>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h2>🚨 Urgent leads waiting on you</h2>
      ${d.urgentOpen.length ? `<div class="table-wrap"><table class="lead-table"><tbody>${d.urgentOpen.map(leadRow).join("")}</tbody></table></div>` : `<p class="muted" style="margin:0">Nothing urgent right now.</p>`}
    </div>`;

  view.querySelectorAll("[data-days]").forEach((b) =>
    b.addEventListener("click", () => {
      dashDays = Number(b.dataset.days);
      renderDashboard();
    }),
  );
  bindLeadRows();
  drawDailyChart($("#daily-chart"), c.daily);
}

function funnel(f) {
  const max = Math.max(1, ...STATUSES.map((s) => f[s]));
  return STATUSES.map(
    (s) => `<div class="funnel-row"><span>${STATUS_LABEL[s]}</span>
      <div class="track"><div class="bar" style="width:${(f[s] / max) * 100}%;${f[s] ? "" : "min-width:0"}"></div></div>
      <span class="num" style="text-align:right">${f[s]}</span></div>`,
  ).join("");
}

// Grouped bars: two series, one shared y-axis, hover tooltip per day.
function drawDailyChart(el, daily) {
  // Size the viewBox to the real container width so 11px labels stay 11px on phones.
  const W = Math.max(300, Math.round(el.clientWidth || 640)), H = 220, padL = 28, padB = 24, padT = 8;
  const max = Math.max(4, ...daily.map((d) => Math.max(d.missed, d.replied)));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const plotW = W - padL, plotH = H - padB - padT;
  const groupW = plotW / daily.length;
  const barW = Math.max(2, Math.min(18, (groupW - 10) / 2));
  const y = (v) => padT + plotH - (v / top) * plotH;
  const labelEvery = Math.ceil(daily.length / Math.max(4, Math.floor(W / 64)));

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily missed calls and replies">`;
  for (let i = 0; i <= 4; i++) {
    const v = step * i;
    svg += `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    svg += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  svg += "<!--hits-->";
  let hits = "";
  daily.forEach((d, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const bar = (v, x, color) => {
      if (!v) return "";
      const h = Math.max(2, (v / top) * plotH);
      const yy = padT + plotH - h, r = Math.min(4, barW / 2, h);
      // Rounded top, square base anchored to the baseline.
      return `<path d="M${x},${padT + plotH} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + barW - r} Q${x + barW},${yy} ${x + barW},${yy + r} V${padT + plotH} Z" fill="${color}" pointer-events="none"/>`;
    };
    svg += bar(d.missed, cx - barW - 1, "var(--series-1)");
    svg += bar(d.replied, cx + 1, "var(--series-2)");
    if (i % labelEvery === 0 || i === daily.length - 1) {
      const dt = new Date(d.date + "T12:00:00Z");
      const lbl = daily.length <= 7 ? dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) : dt.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" });
      svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle" pointer-events="none">${lbl}</text>`;
    }
    hits += `<rect class="hit" data-i="${i}" x="${padL + groupW * i}" y="${padT}" width="${groupW}" height="${plotH}" fill="transparent"/>`;
  });
  // Hover bands sit BEHIND the bars (bars ignore the pointer), so the
  // highlight never washes out the data it's highlighting.
  svg = svg.replace("<!--hits-->", hits) + `</svg>`;
  el.innerHTML = svg + `<div class="tooltip" hidden></div>`;

  const tip = el.querySelector(".tooltip");
  const svgEl = el.querySelector("svg");
  el.querySelectorAll(".hit").forEach((r) => {
    r.addEventListener("mouseenter", () => {
      const d = daily[Number(r.dataset.i)];
      const dt = new Date(d.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
      tip.innerHTML = `<b>${dt}</b><div><i style="background:var(--series-1)"></i>Missed calls: ${d.missed}</div><div><i style="background:var(--series-2)"></i>Replied: ${d.replied}</div>`;
      const scale = svgEl.getBoundingClientRect().width / W;
      const x = (Number(r.getAttribute("x")) + groupW / 2) * scale;
      tip.style.left = Math.min(Math.max(x, 70), el.clientWidth - 70) + "px";
      tip.style.top = y(Math.max(d.missed, d.replied)) * scale - 6 + "px";
      tip.hidden = false;
      r.setAttribute("fill", "var(--grid)");

    });
    r.addEventListener("mouseleave", () => {
      tip.hidden = true;
      r.setAttribute("fill", "transparent");
    });
  });
}

// ---------- leads ----------

let leadFilter = "OPEN";
let leadSearch = "";

function leadRow(l) {
  const preview = l.lastMessage ? `${l.lastMessage.direction === "INBOUND" ? "" : "You: "}${l.lastMessage.body}` : l.jobDescription || "";
  return `<tr class="clickable" data-lead="${esc(l.id)}">
    <td><b>${esc(l.name || phone(l.phone))}</b>${l.name ? `<div class="muted">${esc(phone(l.phone))}</div>` : ""}</td>
    <td>${esc(preview).slice(0, 140)}${l.address ? `<div class="muted">📍 ${esc(l.address)}</div>` : ""}</td>
    <td><span class="pill ${esc(l.status)}">${STATUS_LABEL[l.status]}</span>
      ${l.urgent ? ` <span class="pill urgent">Urgent</span>` : ""}${l.optedOut ? ` <span class="pill optout">Opted out</span>` : ""}</td>
    <td class="muted when" style="white-space:nowrap">${ago(lastActivity(l))}</td></tr>`;
}
function lastActivity(l) {
  return [l.lastInboundAt, l.lastOutboundAt, l.createdAt].filter(Boolean).sort().at(-1);
}
function bindLeadRows() {
  view.querySelectorAll("[data-lead]").forEach((tr) => tr.addEventListener("click", () => (location.hash = `#/leads/${tr.dataset.lead}`)));
}

async function renderLeads() {
  const qs = new URLSearchParams();
  if (leadFilter !== "ALL") qs.set("status", leadFilter);
  if (leadSearch) qs.set("search", leadSearch);
  const { leads } = await api(`/leads?${qs}`);
  view.innerHTML = `
    <h1>Leads</h1><p class="sub">Everyone who called or texted. Tap a lead to see the conversation and reply.</p>
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Filter by status">
        ${["OPEN", "ALL", ...STATUSES].map((s) => `<button class="chip" data-filter="${s}" aria-pressed="${s === leadFilter}">${s === "OPEN" ? "Open" : s === "ALL" ? "All" : STATUS_LABEL[s]}</button>`).join("")}
      </div>
      <input id="search" placeholder="Search name, phone, job, address" value="${esc(leadSearch)}" style="max-width:300px">
    </div>
    <div class="card" style="padding:4px 10px">
      ${leads.length ? `<div class="table-wrap"><table class="lead-table"><thead><tr><th>Contact</th><th>Latest</th><th>Status</th><th>Updated</th></tr></thead>
        <tbody>${leads.map(leadRow).join("")}</tbody></table></div>`
        : `<div class="empty">No leads here yet. When a call is missed, the caller shows up here within seconds.</div>`}
    </div>`;
  view.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      leadFilter = b.dataset.filter;
      renderLeads();
    }),
  );
  const search = $("#search");
  search.addEventListener("input", () => {
    clearTimeout(renderLeads.t);
    renderLeads.t = setTimeout(() => {
      leadSearch = search.value.trim();
      renderLeads().then(() => {
        const s = $("#search");
        s.focus();
        s.setSelectionRange(s.value.length, s.value.length);
      });
    }, 300);
  });
  bindLeadRows();
}

const KIND_LABEL = { TEXT_BACK: "Auto text-back", QUALIFY: "Auto", FOLLOW_UP: "Auto follow-up", REMINDER: "Reminder", MANUAL: "You" };

async function renderLead(id) {
  const { lead, messages, calls, scheduled, previousLeads } = await api(`/leads/${encodeURIComponent(id)}`);
  const timeline = [
    ...messages.map((m) => ({ at: m.createdAt, html: bubble(m) })),
    ...calls.map((c) => ({
      at: c.createdAt,
      html: `<div class="event">📞 ${c.outcome === "ANSWERED" ? "Answered call" : "Missed call"}${c.afterHours ? " (after hours)" : ""} · ${when(c.createdAt)}
        ${c.hasVoicemail ? `<audio controls preload="none" data-vm="${esc(c.id)}"></audio>` : ""}</div>`,
    })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  const apptLocal = lead.appointmentAt ? toLocalInput(lead.appointmentAt) : "";
  view.innerHTML = `
    <p><a href="#/leads">← All leads</a></p>
    <div class="row" style="justify-content:space-between;margin-bottom:16px">
      <div><h1>${esc(lead.name || phone(lead.phone))}</h1>
      <p class="sub" style="margin:0"><a href="tel:${esc(lead.phone)}">${esc(phone(lead.phone))}</a> · first contact ${when(lead.createdAt)}${previousLeads ? ` · ${previousLeads} earlier job${previousLeads > 1 ? "s" : ""}` : ""}</p></div>
      <div class="row">${lead.urgent ? `<span class="pill urgent">Urgent</span>` : ""}${lead.optedOut ? `<span class="pill optout">Replied STOP — can't text</span>` : ""}
        <a class="btn secondary" href="tel:${esc(lead.phone)}">Call back</a></div>
    </div>
    <div class="grid two">
      <div class="card">
        <h2>Conversation</h2>
        <div class="thread" id="thread">${timeline.map((t) => t.html).join("") || `<div class="event">No messages yet</div>`}</div>
        <form class="reply" id="reply-form">
          <textarea name="body" placeholder="${lead.optedOut ? "This contact opted out of texts" : "Type a text to the customer…"}" maxlength="1200" ${lead.optedOut ? "disabled" : ""} required></textarea>
          <button class="btn" ${lead.optedOut ? "disabled" : ""}>Send</button>
        </form>
        ${scheduled.length ? `<p class="muted" style="font-size:12.5px;margin:10px 0 0">Scheduled: ${scheduled.map((s) => `${s.type === "FOLLOW_UP" ? "follow-up" : "reminder"} ${when(s.runAt)}`).join(" · ")}</p>` : ""}
      </div>
      <div class="stack">
        <form class="card" id="lead-form">
          <h2>Lead details</h2>
          <label>Status<select name="status">${STATUSES.map((s) => `<option value="${s}" ${s === lead.status ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}</select></label>
          <label>Name<input name="name" value="${esc(lead.name)}" maxlength="80"></label>
          <label>Job<textarea name="jobDescription" maxlength="1000">${esc(lead.jobDescription)}</textarea></label>
          <label>Address<input name="address" value="${esc(lead.address)}" maxlength="300"></label>
          <label>Job value ($)<input name="jobValue" type="number" min="0" step="1" value="${lead.jobValueCents != null ? lead.jobValueCents / 100 : ""}">
            <div class="hint">Fill in when you win the job — it powers "Revenue won".</div></label>
          <label class="check"><input type="checkbox" name="urgent" ${lead.urgent ? "checked" : ""}> Urgent</label>
          <label>Notes<textarea name="notes" maxlength="4000">${esc(lead.notes)}</textarea></label>
          <button class="btn">Save</button>
        </form>
        <form class="card" id="appt-form">
          <h2>Appointment</h2>
          <label>Date & time (${esc(me.business.timezone)})<input name="at" type="datetime-local" value="${apptLocal}" required></label>
          <div class="row"><button class="btn">${lead.appointmentAt ? "Reschedule" : "Book"}</button>
          ${lead.appointmentAt ? `<button type="button" class="btn danger" id="appt-clear">Cancel appointment</button>` : ""}</div>
          <p class="hint">The customer gets a reminder text 24 hours and 2 hours before (never between 9pm and 8am).</p>
        </form>
      </div>
    </div>`;

  const thread = $("#thread");
  thread.scrollTop = thread.scrollHeight;
  view.querySelectorAll("audio[data-vm]").forEach(loadVoicemail);

  $("#reply-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button");
    btn.disabled = true;
    try {
      await api(`/leads/${lead.id}/messages`, { method: "POST", body: { body: ev.target.body.value } });
      await renderLead(lead.id);
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  });
  $("#lead-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const nullable = (v) => (v.trim() === "" ? null : v.trim());
    try {
      await api(`/leads/${lead.id}`, {
        method: "PATCH",
        body: {
          status: f.status.value,
          name: nullable(f.name.value),
          jobDescription: nullable(f.jobDescription.value),
          address: nullable(f.address.value),
          notes: nullable(f.notes.value),
          urgent: f.urgent.checked,
          jobValue: f.jobValue.value === "" ? null : Number(f.jobValue.value),
        },
      });
      toast("Saved");
      await renderLead(lead.id);
    } catch (e) {
      toast(e.message);
    }
  });
  $("#appt-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api(`/leads/${lead.id}/appointment`, { method: "PUT", body: { at: fromLocalInput(ev.target.at.value) } });
      toast("Booked — reminders scheduled");
      await renderLead(lead.id);
    } catch (e) {
      toast(e.message);
    }
  });
  $("#appt-clear")?.addEventListener("click", async () => {
    await api(`/leads/${lead.id}/appointment`, { method: "DELETE" });
    toast("Appointment cancelled");
    await renderLead(lead.id);
  });
}

function bubble(m) {
  const out = m.direction === "OUTBOUND";
  const failed = ["failed", "undelivered"].includes(m.status);
  const meta = `${out ? esc(KIND_LABEL[m.kind] || "") + " · " : ""}${when(m.createdAt)}${failed ? ` · <span style="color:var(--crit)">⚠ not delivered${m.error ? ": " + esc(m.error) : ""}</span>` : ""}`;
  return `<div class="bubble ${out ? "out" : "in"}">${esc(m.body)}<span class="meta">${meta}</span></div>`;
}

async function loadVoicemail(audio) {
  try {
    const res = await fetch(`/api/calls/${audio.dataset.vm}/voicemail`, { headers: { authorization: "Bearer " + token() } });
    if (!res.ok) throw new Error();
    audio.src = URL.createObjectURL(await res.blob());
  } catch {
    audio.replaceWith(Object.assign(document.createElement("span"), { textContent: " (voicemail unavailable)" }));
  }
}

// datetime-local inputs are wall-clock time with no zone; interpret them in
// the BUSINESS's timezone, not the browser's.
function tzOffsetMs(date, zone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(date).map((x) => [x.type, x.value]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}
function fromLocalInput(value) {
  const [d, t] = value.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m] = t.split(":").map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m);
  let ts = guess - tzOffsetMs(new Date(guess), tz());
  ts = guess - tzOffsetMs(new Date(ts), tz()); // second pass settles DST edges
  return new Date(ts).toISOString();
}
function toLocalInput(iso) {
  const local = new Date(new Date(iso).getTime() + tzOffsetMs(new Date(iso), tz()));
  return local.toISOString().slice(0, 16);
}

// ---------- settings ----------

async function renderSettings() {
  me = await api("/me");
  const b = me.business;
  const hours = b.businessHours || {};
  view.innerHTML = `
    <h1>Settings</h1><p class="sub">How calls are handled and what customers get texted.</p>
    <div class="stack">
      <section class="card">
        <h2>1. Your business number</h2>
        ${b.twilioNumber
          ? `<p style="margin:0">Customers call and text <b>${esc(phone(b.twilioNumber))}</b>.</p>`
          : `<p class="muted" style="margin-top:0">Get a local number for your area, or connect one you already bought in Twilio.</p>
             <div class="row"><input id="area" placeholder="Area code, e.g. 512" maxlength="3" style="max-width:180px" inputmode="numeric">
             <button class="btn secondary" id="find-numbers">Find numbers</button></div>
             <div id="number-results" style="margin-top:10px"></div>
             <p class="hint">Already have a Twilio number? Enter it under Call handling below and point its webhooks at:<br>
               Voice <span class="code">${esc(me.setup.webhookUrls.voice)}</span><br>SMS <span class="code">${esc(me.setup.webhookUrls.sms)}</span></p>`}
        ${me.setup.a2pMessagingService ? "" : `<p class="hint">⚠ US texting needs A2P 10DLC registration (brand + campaign) before carriers deliver reliably. See the README's "Before you go live" checklist.</p>`}
      </section>

      <form class="card" id="settings-form">
        <h2>2. Call handling</h2>
        <div class="form-grid">
          <label>Business name<input name="name" value="${esc(b.name)}" required></label>
          <label>Your first name (used in texts)<input name="ownerName" value="${esc(b.ownerName)}" required></label>
          <label>Your cell (alerts + rings first)<input name="ownerPhone" value="${esc(phone(b.ownerPhone))}" required></label>
          <label>Twilio number<input name="twilioNumber" value="${esc(b.twilioNumber ? phone(b.twilioNumber) : "")}" placeholder="Not connected"></label>
          <label>Timezone<input name="timezone" value="${esc(b.timezone)}" required></label>
          <label>Average job value ($)<input name="avgJobValue" type="number" min="0" value="${b.avgJobValueCents / 100}">
            <div class="hint">Used to estimate pipeline saved.</div></label>
        </div>
        <label>How calls reach us
          <select name="callMode">
            <option value="DIAL" ${b.callMode === "DIAL" ? "selected" : ""}>Customers call the Twilio number — ring my cell first</option>
            <option value="CARRIER_FORWARD" ${b.callMode === "CARRIER_FORWARD" ? "selected" : ""}>I keep my number — my carrier forwards unanswered calls</option>
          </select>
          <div class="hint">Forwarding: on most US carriers dial <span class="code">*71</span> + the Twilio number (Verizon), or <span class="code">**61*</span>number<span class="code">#</span> (AT&T/T-Mobile). Check with your carrier.</div>
        </label>
        <div class="form-grid">
          <label>Ring my cell for (seconds)<input name="ringTimeoutSec" type="number" min="10" max="45" value="${b.ringTimeoutSec}">
            <div class="hint">Keep under your voicemail pickup (~20s).</div></label>
          <label>Don't re-text the same caller within (minutes)<input name="dedupeWindowMin" type="number" min="0" value="${b.dedupeWindowMin}"></label>
        </div>
        <label class="check"><input type="checkbox" name="screenCalls" ${b.screenCalls ? "checked" : ""}> Ask me to "press 1 to accept" (so my voicemail picking up still counts as missed)</label>
        <label class="check"><input type="checkbox" name="recordVoicemail" ${b.recordVoicemail ? "checked" : ""}> Let callers leave a voicemail</label>

        <h2 style="margin-top:20px">3. Texts</h2>
        <label>Missed-call text (business hours)<textarea name="textBackMessage" maxlength="480">${esc(b.textBackMessage)}</textarea></label>
        <label>Missed-call text (after hours)<textarea name="afterHoursMessage" maxlength="480">${esc(b.afterHoursMessage)}</textarea>
          <div class="hint">Placeholders: <span class="code">{business}</span> <span class="code">{owner}</span> <span class="code">{number}</span>. Keep "Reply STOP to opt out" in the first text.</div></label>
        <label class="check"><input type="checkbox" name="qualifyEnabled" ${b.qualifyEnabled ? "checked" : ""}> Ask callers 3 quick questions (job, address, emergency?) and text me a summary</label>
        <div class="row">
          <label class="check" style="margin:0"><input type="checkbox" name="followUpEnabled" ${b.followUpEnabled ? "checked" : ""}> Send one follow-up if no reply after</label>
          <input name="followUpDelayMin" type="number" min="15" value="${b.followUpDelayMin}" style="width:90px"> <span class="muted">minutes</span>
        </div>
        <label class="check" style="margin-top:12px"><input type="checkbox" name="weeklyDigestEnabled" ${b.weeklyDigestEnabled ? "checked" : ""}> Text + email me a summary every Monday at 8am</label>

        <h2 style="margin-top:20px">4. Business hours</h2>
        <div class="hours">
          <span></span><span class="muted">Open</span><span class="muted">Close</span><span class="muted">Closed</span>
          ${DAYS.map((d) => {
            const h = hours[d];
            return `<b style="text-transform:capitalize">${d}</b>
              <input type="time" name="open_${d}" value="${h ? esc(h.open) : "08:00"}" ${h ? "" : "disabled"}>
              <input type="time" name="close_${d}" value="${h ? esc(h.close) : "17:00"}" ${h ? "" : "disabled"}>
              <input type="checkbox" name="closed_${d}" ${h ? "" : "checked"} aria-label="Closed ${d}" style="width:auto">`;
          }).join("")}
        </div>
        <div class="error" id="settings-error"></div>
        <button class="btn">Save settings</button>
      </form>
    </div>`;

  $("#find-numbers")?.addEventListener("click", async () => {
    const out = $("#number-results");
    try {
      const { numbers } = await api(`/numbers/search?areaCode=${encodeURIComponent($("#area").value)}`);
      out.innerHTML = numbers.length
        ? numbers.map((n) => `<div class="row" style="margin:6px 0"><b class="num">${esc(phone(n.phoneNumber))}</b> <span class="muted">${esc([n.locality, n.region].filter(Boolean).join(", "))}</span>
            <button class="btn secondary" data-buy="${esc(n.phoneNumber)}">Use this number</button></div>`).join("")
        : `<p class="muted">No numbers available in that area code. Try a neighboring one.</p>`;
      out.querySelectorAll("[data-buy]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await api("/numbers/purchase", { method: "POST", body: { phoneNumber: btn.dataset.buy } });
            toast("Number connected 🎉");
            me = null;
            route();
          } catch (e) {
            toast(e.message);
            btn.disabled = false;
          }
        }),
      );
    } catch (e) {
      out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  });

  const form = $("#settings-form");
  DAYS.forEach((d) =>
    form[`closed_${d}`].addEventListener("change", (ev) => {
      form[`open_${d}`].disabled = ev.target.checked;
      form[`close_${d}`].disabled = ev.target.checked;
    }),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const businessHours = {};
    for (const d of DAYS) businessHours[d] = form[`closed_${d}`].checked ? null : { open: form[`open_${d}`].value, close: form[`close_${d}`].value };
    const body = {
      name: form.name.value,
      ownerName: form.ownerName.value,
      ownerPhone: form.ownerPhone.value,
      twilioNumber: form.twilioNumber.value.trim() || null,
      timezone: form.timezone.value.trim(),
      avgJobValue: Number(form.avgJobValue.value || 0),
      callMode: form.callMode.value,
      ringTimeoutSec: Number(form.ringTimeoutSec.value),
      dedupeWindowMin: Number(form.dedupeWindowMin.value),
      screenCalls: form.screenCalls.checked,
      recordVoicemail: form.recordVoicemail.checked,
      textBackMessage: form.textBackMessage.value,
      afterHoursMessage: form.afterHoursMessage.value,
      qualifyEnabled: form.qualifyEnabled.checked,
      followUpEnabled: form.followUpEnabled.checked,
      followUpDelayMin: Number(form.followUpDelayMin.value),
      weeklyDigestEnabled: form.weeklyDigestEnabled.checked,
      businessHours,
    };
    try {
      await api("/settings", { method: "PATCH", body });
      $("#settings-error").textContent = "";
      toast("Settings saved");
      me = null;
      route();
    } catch (e) {
      $("#settings-error").textContent = e.message;
    }
  });
}

route();
