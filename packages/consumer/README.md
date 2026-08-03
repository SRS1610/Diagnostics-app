# @diagnostics/consumer

The customer-facing trade-in tracker: see the inspection outcome and the
offer, accept or decline it, choose a payout method, and request a review.
Reached from the link (or QR) printed on the inspection report.

```bash
npm run dev      # http://localhost:5174
npm run build
npm run preview
```

`VITE_API_BASE_URL` points at the API (default `http://localhost:4000`).
A working link looks like `/track/<consumerToken>`; the portal's report
detail page will show you one.

## Why this is a separate app from the portal

They must not share an origin. The portal keeps a staff session token in
`localStorage`; a consumer page served from the same origin would sit in
the same storage area and the same bundle. Separating them means a
customer's browser never loads portal code and never has anywhere to put
a staff credential.

## The token is the credential

There is no login. Each report carries a 256-bit `consumerToken` minted
at creation, and holding it is what authorises access to that one
report — nothing else, and nothing in any other tenant. Consequences
that shaped the code:

- The app writes **nothing** to `localStorage` or `sessionStorage`. A
  borrowed or shared phone must not leave a trade-in link behind.
- `<meta name="referrer" content="no-referrer">` stops the token in the
  URL leaking to any third party the page links to.
- `<meta name="robots" content="noindex">`, since every URL is a secret.
- The portal reveals the link on request rather than displaying it by
  default, and says what it grants.

See `packages/api/src/routes/publicTracker.ts` for the server half — in
particular why the response is a whitelist rather than the row, and why
serial and IMEI are shown masked here but in full in the portal.

## Known limits

- **No photo attachment on a review request.** The design allows one;
  there is no file storage in this system yet, and a picker that
  silently discards the photo would be worse than not offering it.
- **Payout is a recorded choice, not a payment.** No processor is
  integrated. The page says so rather than showing a "pending" state
  that implies money is moving.
- **No notifications.** Stage changes are visible when the customer
  reopens their link; nothing emails or texts them, because no provider
  is wired up.
