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
| **Multi-business** | Each business only sees its own data. Webhooks find the business from the number dialled. |

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
npm run db:seed             # demo@tradecall.test / demo-password
npm run dev                 # http://localhost:4100
```

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
npm test             # 71 tests against real Postgres
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

- One login per business (no team accounts yet), and no billing.
- Intake questions are the same for every trade.
- "Jobs saved" is callers who replied × your average job value. It's an
  estimate and is labelled that way. "Revenue won" is only what you record.
