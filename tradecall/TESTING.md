# Testing TradeCall

Three levels, from fastest to most realistic. Do them in order: each one
catches things the previous one can't.

| Level | Needs | Time | Proves |
|---|---|---|---|
| 1. Automated tests | Node 20+, Postgres | 1 min | All the logic: call flow, texts, teams, isolation between businesses, the Telnyx adapter |
| 2. Demo mode on your computer | Same | 15 min | The whole product, by hand, with simulated calls and texts |
| 3. Real phones on Telnyx | Telnyx account, public server | 1–2 hours | Real carriers, real phones, real voicemail |

---

## Setup (once)

```bash
cd tradecall
npm install
cp .env.example .env          # set JWT_SECRET to any 32+ characters (openssl rand -hex 32)
# Postgres: create a user "textback" (password "textback_dev") and two databases,
# tradecall_dev and tradecall_test — or point DATABASE_URL / TEST_DATABASE_URL at your own.
npx prisma migrate deploy     # dev database
npm run test:setup            # test database
```

---

## Level 1 — Automated tests

```bash
npm test          # 102 tests against a real Postgres
npm run typecheck
```

Every test should pass. These cover:
- every call outcome (answered, no answer, owner's voicemail, caller hangs up, forwarded);
- the text conversation, opt-outs, follow-ups and reminders (with a fake clock);
- roles, invites and seats;
- suspension, deletion, and the read-only support view;
- one business never seeing another's data;
- the Telnyx adapter, using realistic webhooks signed with a real key.

---

## Level 2 — Demo mode on your computer

With no `TELNYX_*` keys set, the server runs in **demo mode**. Nothing is really called or texted. Instead, every text and call step is printed in the server's terminal.

**Terminal 1 — the server**

```bash
npm run db:seed     # demo businesses, team, three weeks of history
npm run dev         # http://localhost:4100
```

**Terminal 2 — play out calls and texts**

```bash
npm run simulate -- missed          # owner doesn't pick up → caller gets a text, voicemail recorded
npm run simulate -- hangup          # caller gives up while it's still ringing → still texted back
npm run simulate -- voicemail       # owner's own voicemail answers (nobody presses 1) → counts as missed
npm run simulate -- answered        # owner presses 1 → connected, NO text sent
npm run simulate -- conversation    # missed call, then the caller answers all 3 questions
npm run simulate -- text "Do you install water softeners?"   # a new customer texts in
npm run simulate -- owner-reply "On my way"                   # owner replies to the latest alert by SMS
```

Add `--from +15125559001` to play the same caller again (e.g. to see that redialing within an hour doesn't text twice), or `--to +15125550299` to call a different business.

**What to check in the browser** (http://localhost:4100):

| Sign in as | Password | Check |
|---|---|---|
| `demo@tradecall.test` (owner) | `demo-password` | **Inbox:** each simulated caller appears with the conversation and the call/voicemail in the timeline. **Dashboard:** missed-call numbers go up, and "Why calls were missed" shows each reason. **Team:** invite someone, copy the link, open it in a private window and join. **Settings:** change the missed-call text, then run `simulate missed` again to see it used. |
| `jo@tradecall.test` (admin) | `demo-password` | Can change settings and the team, but can't change an owner. |
| `luis@tradecall.test` (member) | `demo-password` | Inbox only: no Settings, can't invite. |
| `admin@tradecall.test` (platform console) | `admin-password` | **+ New business.** Open a business, then **Open read-only support view** (try to send a text: it's refused). **Suspend** a business, then run `npm run simulate -- missed --to <its number>`: the call is hung up and nothing is texted. **Reactivate**, then suspend again and **Delete** (you must type the exact name). |

Things worth trying on purpose:
- Text `STOP` with `npm run simulate -- text STOP --from +15125559001`, then `simulate missed --from +15125559001`. No text should go out.
- `simulate conversation`, then in the Inbox book an appointment. Reminders appear under "Scheduled" and never fall between 9pm and 8am.
- Sign in as Lone Star's owner and try to open a Cool Air lead's URL. It's "not found".

---

## Level 3 — Real phones on Telnyx

Demo mode can't prove how real carriers behave. Do this before any customer relies on it.

**Setup:** follow README → *Connect Telnyx*. The server must be on a public HTTPS address, e.g. deployed on Render, or `ngrok http 4100` while testing. Set `PUBLIC_URL` to that address and add all three `TELNYX_*` keys. The startup log should say `via telnyx`, not `fake`.

**You'll need:** the owner's cell (Phone A) and one other phone (Phone B). Use a phone that isn't on your team. Calls from team members' phones are treated as "line tests", not customers.

| # | Do this | Expect |
|---|---|---|
| 1 | Call the TradeCall number from **Phone A** (the owner's cell) | "Your TradeCall line is set up correctly", then hang-up. Settings → Setup ticks "Test the line". |
| 2 | Call from **Phone B**; answer on Phone A and **press 1** | You're connected. Phone B gets **no** text. |
| 3 | Call from Phone B; **don't answer** Phone A | After about 18s, Phone B hears the greeting and the beep. Leave a message. Phone B gets the text-back within seconds. Phone A gets a voicemail alert, and the recording plays in the Inbox. |
| 4 | Call from Phone B; Phone A **declines** | Same as #3. |
| 5 | Call from Phone B and **hang up after 2 rings** | Phone B still gets the text-back. |
| 6 | Turn Phone A's voicemail on, call from Phone B, let Phone A's voicemail answer | Phone A's voicemail never hears a "1", so Phone B is treated as missed and texted. If Phone B's call connects to Phone A's voicemail instead, lower **Ring my cell for** below your carrier's voicemail pickup time. |
| 7 | Reply from Phone B: job → address → "yes" | All three questions arrive, and Phone A gets an 🚨 URGENT summary. |
| 8 | Reply to that alert **from Phone A** | Phone B receives your reply from the business number. |
| 9 | Text **STOP** from Phone B, then call and miss again | No more texts to Phone B. |
| 10 | Turn on *I keep my own number* (Settings), set your carrier's no-answer forwarding to the TradeCall number, call your **own** number from Phone B and don't answer | The call forwards, and Phone B is texted back. |

**Things only real testing tells you:**
- **Does the caller hear ringing** while Phone A is being dialled? It's expected, but it depends on the carrier.
- **Do texts actually arrive?** Until 10DLC registration is approved, US carriers may silently filter them. Check delivery status in the Inbox: "⚠ not delivered" shows the carrier's reason.
- **Forwarding codes** vary by carrier and plan (test #10).

Write down anything that differs from the "Expect" column. Those are the bugs worth fixing before launch.
