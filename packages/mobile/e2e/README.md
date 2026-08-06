# Mobile e2e — API client integration

The React Native app can't be driven in a browser and standing up an iOS
Simulator or Android Emulator in CI is a much larger commitment than the
actual risk here justifies. What this suite catches instead is
**payload-shape drift and endpoint-contract regressions** on the four
routes `packages/mobile/src/api/client.ts` calls into:

1. `POST /technicians/login` — Step 1 (badge scan / manual code)
2. `GET  /profiles/tenants/:tenantId/profiles/by-pin/:pin` — Step 2
3. `GET  /licenses/tenants/:tenantId/check` — Step 3
4. `POST /reports` — session end (only authenticated write)

Same shape as `packages/consumer/e2e/` — a tiny Node script, pass/fail
per check, non-zero exit on failure.

## Running

```bash
# 1. A running API against a seeded dev DB
npm run dev --workspace=packages/api
npx --workspace=packages/api prisma db seed   # once — creates Acme Wireless / TEC-1042 / PIN 4726

# 2. The suite
npm run test:e2e --workspace=packages/mobile
```

Overrides:

- `API_URL` (default `http://localhost:4000`)
- `MOBILE_E2E_BADGE` / `MOBILE_E2E_PIN` — if you seeded different values
