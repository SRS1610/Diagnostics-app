# Missed Call Textback

For plumbers, HVAC techs, roofers and electricians who can't pick up while
they're on a job. When a call is missed, the caller gets a text **within
seconds**, the system asks them what they need, texts the owner a summary,
nudges people who go quiet, reminds booked customers before the visit, and
sends the owner a Monday-morning summary of what it saved them.

```
caller ──► Twilio number ──► ring owner's cell (press 1 to accept)
                               │ no answer / voicemail picked up
                               ▼
               "Sorry we missed you — what can we help with?"   (instant SMS)
                               │ caller replies
                               ▼
          job? → address? → emergency? ──► owner gets a lead summary by SMS
                               │ no reply in 2h
                               ▼
                      one follow-up nudge (never 9pm–8am)
```

## What's in the box

| Feature | Where |
|---|---|
| Missed-call detection, two modes: **DIAL** (Twilio rings your cell first; a "press 1" screen stops your own voicemail from counting as answered) or **CARRIER_FORWARD** (keep your number; your carrier forwards unanswered calls) | `src/routes/twilio.ts` |
| Instant text-back, separate after-hours message, redial de-duplication, never texts the owner or anyone who replied STOP | `src/services/missedCall.ts` |
| 3-question intake (job → address → emergency?), urgency detection, owner alert with summary + link | `src/services/conversation.ts` |
| STOP/START opt-out handling, stored per phone number, enforced on the single send path | `src/services/messaging.ts` |
| Follow-up nudge + appointment reminders (24h and 2h before), quiet hours, retries, safe with multiple workers | `src/services/scheduler.ts` |
| Voicemail recording with owner alert and in-dashboard playback | `src/routes/twilio.ts`, `src/routes/api.ts` |
| Dashboard: missed calls, reply rate, pipeline saved, revenue won, daily chart, lead funnel, urgent queue | `src/services/stats.ts`, `public/` |
| Leads inbox: two-way texting, status, job value, appointment booking | `public/app.js` |
| Weekly digest, Monday 8am in each business's own timezone, by SMS (+ email via SendGrid) | `src/services/digest.ts` |
| Self-serve number search and purchase | `src/lib/telephony.ts` |
| Multi-business: every business is isolated by `businessId` from its login; webhooks resolve the business from the number called | throughout |

Stack: Node 20+, Express, Prisma, Postgres, Twilio. The dashboard is plain
HTML/JS served by the same server — no front-end build step.

## Run it locally

```bash
cp .env.example .env              # set JWT_SECRET (openssl rand -hex 32)
npm install
npx prisma migrate deploy
npm run db:seed                   # optional demo data: demo@example.com / demo-password
npm run dev                       # http://localhost:4000
```

Without Twilio credentials the app runs in **demo mode**. Everything works and
every text shows up in the dashboard, but nothing is actually sent.

To exercise the call flow by hand, set `TWILIO_VALIDATE_SIGNATURES=false`
(local only) and post the same fields Twilio would:

```bash
curl -X POST localhost:4000/twilio/voice/incoming    -d CallSid=CA1 -d From=+15125559001 -d To=+15125550199
curl -X POST localhost:4000/twilio/voice/dial-result -d CallSid=CA1 -d DialCallStatus=no-answer
curl -X POST localhost:4000/twilio/sms/incoming      -d MessageSid=SM1 -d From=+15125559001 -d To=+15125550199 --data-urlencode "Body=Water heater leaking"
```

## Tests

```bash
npm run test:setup   # migrates the test DB (TEST_DATABASE_URL, default textback_test)
npm test             # 64 tests against real Postgres; Twilio is faked, signatures are real
npm run typecheck
```

## Connect Twilio

1. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `PUBLIC_BASE_URL` (in dev,
   an ngrok HTTPS URL).
2. In the dashboard, **Settings → Find numbers** buys a local number and
   points its webhooks at this server automatically. To use a number you
   already own instead, enter it in Settings and set its webhooks in the
   Twilio console:
   - Voice → `POST {PUBLIC_BASE_URL}/twilio/voice/incoming`
   - Messaging → `POST {PUBLIC_BASE_URL}/twilio/sms/incoming`
     (on a Messaging Service, set this as the *service's* inbound webhook)
3. Choose a call mode:
   - **DIAL**: customers call the Twilio number and it rings your cell first.
     Keep the ring timeout under your carrier voicemail pickup (~20s).
   - **CARRIER_FORWARD**: keep your existing number and turn on
     "forward when unanswered" to the Twilio number. Codes vary by carrier;
     typical ones are Verizon `*71<number>` and AT&T/T-Mobile
     `**61*<number>#`.

## Before you go live (US) — not optional

- **A2P 10DLC registration.** Carriers filter or block unregistered
  business texting from local numbers. Register a Brand and a Campaign in
  Twilio (Trust Hub → Messaging), put the numbers in that Messaging Service,
  and set `TWILIO_MESSAGING_SERVICE_SID`. Expect it to take days to weeks and
  cost a registration fee. Pick the campaign use case that matches (e.g.
  "Customer Care"), and use the default text-back message as the sample.
- **Consent (TCPA).** Texting back someone who just called you is generally
  treated as a response to contact they started. Follow-ups and reminders
  should stay transactional, never promotional. STOP is honoured
  automatically; keep "Reply STOP to opt out" in the first text. Have a
  lawyer confirm this for your states before selling it — this README
  isn't legal advice.
- **Quiet hours.** Automated texts are held to 8:00am–8:59pm in the
  business's timezone. The instant text-back is exempt because it answers
  a call that just happened.
- **Webhook security.** `TWILIO_VALIDATE_SIGNATURES` must stay `true` in
  production. `PUBLIC_BASE_URL` must match the URL Twilio is configured
  with exactly, or every webhook will be rejected with a 403.

## Deploy

`render.yaml` describes one web service plus Postgres. The background worker
(follow-ups, reminders, digests) runs inside the web process every 30s.
Jobs are stored in Postgres and claimed atomically, so restarts don't lose
them and running several instances doesn't double-send. To run the worker
separately, set `RUN_WORKER=false` on the web instances.

## Known limits / next steps

- One owner login per business — no team members or roles yet.
- The owner replies from the dashboard. Replying directly to the alert SMS
  to reach the customer isn't built yet; it's the most-requested next step
  for people who live in their texts.
- No billing yet. Stripe subscriptions would slot in at signup.
- The intake questions are fixed. Per-trade question sets (roof leak vs. no
  heat) would come next.
- "Pipeline saved" is replies × your average job value — an estimate, and
  labelled as one. "Revenue won" is only what you record on leads.
