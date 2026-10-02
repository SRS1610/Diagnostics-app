# TradeCall

Missed-call text-back for plumbers, HVAC techs, roofers and electricians,
built on **Telnyx** (no Twilio). When a call is missed, the caller gets a
text within seconds. The system asks what they need, alerts the owner,
nudges anyone who goes quiet, reminds booked customers, and sends the
owner a Monday summary of what it saved them.

```
caller ─► TradeCall number ─► rings owner's cell ("press 1 to take it")
             │                   └─ press 1 ─► connected
             │  no answer · voicemail picked up · declined · CALLER HUNG UP
             ▼
   instant text: "Sorry we missed you — what can we help with?"
             │  greeting + voicemail (audio saved immediately)
             ▼
   job? → address? → emergency? ─► owner gets "New lead #12 …"
                                     └─ owner replies to that SMS ─► goes to the customer
```

## Features

| | |
|---|---|
| **Two call modes** | *Ring owner*: callers dial the TradeCall number, your cell rings first, and you press 1 to take it. That way your own voicemail answering still counts as missed. *Forwarded*: keep your number and have your carrier forward unanswered calls. |
| **Catches every miss** | No answer, busy, declined, your voicemail picked up, **or the caller hung up after a few rings**. Hang-ups are the callers most likely to ring a competitor next. |
| **Instant text-back** | Separate after-hours text. One text per caller even if they redial three times. Never texts blocked numbers, your own number, or anyone who said STOP. |
| **Intake** | Asks for the job, the address, and whether it's an emergency. Words like "burst" or "no heat" mark the lead urgent. Cold texts to the number get the same intake. |
| **Reply from your phone** | Alerts arrive as SMS. Reply to one to text that customer, or send `#12 On my way` to a specific lead, or `LEADS` for a list. |
| **Follow-ups & reminders** | One nudge after 2h of silence. Appointment reminders 24h and 2h before. Nothing automated between 9pm and 8am local time. Jobs live in Postgres, survive restarts, and are claimed atomically (no double sends). |
| **Voicemail** | Downloaded the moment it's ready (Telnyx links expire after 10 minutes), stored, and playable in the inbox. |
| **Dashboard** | Missed calls, why they were missed, reply rate, estimated jobs saved, revenue won, daily chart, lead stages, urgent queue. |
| **Inbox** | Lead list and conversation side by side, stages, job value, appointment booking, call/voicemail timeline. |
| **Weekly digest** | Monday 8am in each business's own timezone, by SMS (+ email via Resend). |
| **Multi-tenant SaaS** | Many businesses on one install, each fully separate, with teams, roles, plans and a platform console for you. See below. |

## Multi-tenant: businesses, teams and the platform console

TradeCall is built to be run by **you** for **many businesses**.

**Inside each business (tenant)**

| Role | Can do |
|---|---|
| Owner | Everything, including adding/removing other owners |
| Admin | Settings, phone number, team (except owners), activity log |
| Member | Inbox only: read, reply, update leads, book appointments |

- **Invites:** owners and admins invite by email. The link is also shown so it can be texted. It's single-use, expires in 7 days, and only a hash of it is stored.
- **Alerts go to the whole team:** everyone with alerts on gets new-lead and voicemail texts. Any of them can reply to an alert (or send `#12 message`) to text that customer, and the inbox shows who sent each reply.
- **Seats and texts are capped by plan:** Starter (2 seats, 500 texts/month), Pro (5 / 2,000), Team (20 / 6,000), defined in `src/lib/plans.ts`. Texts over the allowance still go out and show as overage, so a busy week never stops a customer getting their reply.
- **Activity log:** sign-ins, invites, role changes, settings, number purchases, and lead stage/value changes, plus anything TradeCall staff do to the account.
- A business always keeps at least one active owner. Role changes and removals take effect on the very next request.

**Platform console (you)**

Create your login. There is deliberately no public signup for this role:

```bash
npm run platform:admin -- you@yourcompany.com "Your Name"   # prints a one-time password
```

Signing in as a platform admin opens a separate, indigo-themed console (so it's never confused with a customer's view):

- **Businesses:** every tenant with plan, status, seats, texts this month, missed calls and last activity, plus platform-wide totals.
- **Suspend / reactivate**, with a reason that's shown to the business:
  - While suspended, their calls aren't answered and no texts go out.
  - They can sign in and look, but can't change anything.
  - STOP replies are still recorded.
  - Scheduled follow-ups and reminders wait, and resume on reactivation.
- **Change plan, assign a number** already in your Telnyx account, and set the business's own **Telnyx messaging profile**.
- **Read-only support view:** see exactly what the business sees, for one hour. It can't change anything, and it's recorded in that business's own activity log.

**10DLC per business.** US carriers register each business as its own brand and campaign. Register them in Telnyx (as a platform/ISV), then paste that business's messaging profile id in the console. Until then, texts use the platform default profile (`TELNYX_MESSAGING_PROFILE_ID`).

**How tenants are kept separate**

- The signed-in user's business is re-read from the database on every request. Business routes only ever use that value, never an id from the request. Another business's lead, call, voicemail, user or invite is simply "not found".
- Webhooks have no login, so they find the business from the number that was called or texted. Numbers are unique, and businesses can't type in a number they don't own: they buy one through TradeCall, or you assign it.
- The database itself enforces that platform admins belong to no business and every other user belongs to exactly one.
- Tests cover cross-business access for every kind of record, and an independent review of every route found no leaks.

## Architecture

```
src/providers/types.ts      the provider contract: normalized events + commands
src/providers/telnyx/       Telnyx adapter (Call Control v2, Messaging v2, Number Orders, Ed25519 webhook verification)
src/providers/fake.ts       in-memory provider for demo mode and tests
src/core/                   call state machine, missed-call handling, SMS conversation + owner relay, jobs, stats, digest
src/http/                   /webhooks/:provider and the owner /api
public/                     owner dashboard (plain HTML/JS, no build step)
```

Core code never imports Telnyx. To use Plivo, Vonage, Bandwidth or
SignalWire, write one adapter that implements `Provider` and select it in
`src/server.ts`. Nothing in `core/` changes.

The Telnyx adapter's endpoints and field names were checked against the
official `telnyx@7` SDK's TypeScript definitions. Its tests post realistic,
correctly signed Telnyx webhooks and assert the exact REST calls made back.
It has **not yet been run against a live Telnyx account**. Do that first;
see the go-live checklist below.

## Run locally (demo mode, no Telnyx needed)

```bash
cp .env.example .env        # set JWT_SECRET
npm install
npx prisma migrate deploy
npm run db:seed
npm run dev                 # http://localhost:4100
```

Demo logins: `demo@tradecall.test` / `demo-password` (business owner), `jo@tradecall.test` / `demo-password` (admin on the same team), `admin@tradecall.test` / `admin-password` (platform console). The seed also creates two more businesses, one of them suspended.

In demo mode, `/webhooks/fake` accepts unsigned, normalized events, so you can
simulate a call:

```bash
W=localhost:4100/webhooks/fake; H='content-type: application/json'
curl -X POST $W -H "$H" -d '{"eventId":"1","type":"call.incoming","legId":"c1","sessionId":"s1","from":"+15125559001","to":"+15125550199"}'
curl -X POST $W -H "$H" -d '{"eventId":"2","type":"call.ended","legId":"owner-leg-1","cause":"no_answer","state":null}'
curl -X POST $W -H "$H" -d '{"eventId":"3","type":"sms.received","providerId":"m1","from":"+15125559001","to":"+15125550199","text":"Water heater leaking"}'
```

## Tests

```bash
npm run test:setup   # migrate the test DB (TEST_DATABASE_URL, default tradecall_test)
npm test             # 94 tests against real Postgres
npm run typecheck
```

## Connect Telnyx

1. **API key**: Mission Control → Auth → create a V2 API key → `TELNYX_API_KEY`.
2. **Webhook public key**: Mission Control → Keys & Credentials → Public Key → `TELNYX_PUBLIC_KEY`.
3. **Call Control Application**: Voice → Programmable Voice → create an
   application. Set its webhook URL to `{PUBLIC_URL}/webhooks/telnyx`
   (API v2). Its id → `TELNYX_CONNECTION_ID`. Give it an outbound voice
   profile so it can dial the owner's cell.
4. **Messaging profile**: Messaging → create a profile with inbound webhook
   `{PUBLIC_URL}/webhooks/telnyx`. Its id → `TELNYX_MESSAGING_PROFILE_ID`.
5. **Numbers**: in the dashboard, Settings → *Find numbers* orders a number
   already attached to both. Or assign an existing number to the app and
   the profile in Mission Control, then enter it in Settings.
6. Call the number from the owner's cell. You should hear "your line is set
   up correctly". Then call from another phone and let it ring out.

## Before going live (US) — not optional

- **10DLC registration.** US carriers filter or block unregistered business
  texting from local numbers, whichever provider you use. Register a brand
  and campaign in Telnyx (Messaging → 10DLC) and attach the messaging
  profile. Allow days to weeks, plus registration fees.
- **Consent (TCPA).** Replying to someone who just called you is generally
  treated as a response to contact they started. Keep nudges and reminders
  transactional, never promotional. STOP is honoured on every send path. Have
  a lawyer confirm this for your states — this README isn't legal advice.
- **Verify on real phones.** In particular: caller ringback while the owner is
  dialled, the press-1 screen against a real carrier voicemail, and your
  carrier's forwarding code.
- **Keep webhooks signed.** The server refuses to start if Telnyx is only
  partly configured, or if `NODE_ENV=production` has no provider (unless you
  set `DEMO_MODE=true`). Demo mode's `/webhooks/fake` accepts unsigned
  events, so it must never run where real customers can reach it.

## Known limits

- No payment collection yet. Plans and usage are tracked (texts this month, overage, seats), so Stripe subscriptions plus metered overage can be added on top.
- One email = one account = one business. Someone working for two businesses needs two emails.
- Tenant separation is enforced in the application and by tests, not by Postgres row-level security. RLS would be a sensible extra layer before handling very large numbers of tenants.
- Intake questions are the same for every trade.
- "Jobs saved" is callers who replied × your average job value. It's an
  estimate and is labelled that way. "Revenue won" is only what you record.
