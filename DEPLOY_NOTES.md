# Deployment Notes

## Done
- Cloned the visible Lovable auth-gate page as a static HTML/CSS experience in `index.html`.
- Added static Railway runtime via `Dockerfile` + `Caddyfile`.
- Created Railway project: `easy-cloney-ui-clone`.
- Added Railway services: `web`, `Postgres`, `insforge-backend`.
- Set InsForge service env vars:
  - `DATABASE_URL` from Railway Postgres
  - `JWT_SECRET`
  - `ENCRYPTION_KEY`
  - `PORT=7130`
- Generated public InsForge domain:
  - `https://insforge-backend-production.up.railway.app`
- Triggered InsForge deploy from subdirectory path:
  - `railway up ./backend-insforge --path-as-root --service insforge-backend --detach`

## Not Done Yet
- InsForge public endpoint is returning `502` right now, so service health is not complete.
- Frontend clone is static and not yet integrated to InsForge API endpoints.
- Need follow-up deploy/log triage for `insforge-backend` until health is green.

## Update (May 30, 2026 - Pielot Demo)

### Done
- Built full Pielot-inspired multi-screen UI on `/` in `index.html`.
- Added dedicated chat-first demo page at `/demo` in `demo.html`.
- Added backend `server.js` with:
  - static serving for `/` and `/demo`
  - `POST /api/demo-chat` for AI responses
  - fallback logic when provider call fails
- Updated runtime/deploy stack:
  - `package.json` scripts now run `node server.js`
  - added `express` dependency
  - updated `Dockerfile` for Node 20 deploy
- Linked repo to Railway project `Pielot`.
- Created Railway `web` service and deployed successfully.
- Set Railway vars for demo intelligence:
  - `MINIMAX_API_KEY` (set via stdin, not in repo)
  - `DEMO_MODEL=gpt-4.1-mini`
- Live URL:
  - `https://web-production-4277b.up.railway.app`
- Verified with curl:
  - `GET /` returns app HTML
  - `GET /demo` returns demo HTML
  - `POST /api/demo-chat` returns JSON response

### Not Done Yet
- `api/demo-chat` is still replying in fallback mode, which means the current key/base/model combo is not accepted by the upstream endpoint. Next step is setting the correct provider base URL/model for true live completions.

## Update (May 30, 2026 - PRD Backbone)

### Done
- Reworked landing UI to match the provided Pielot visual direction:
  - black outer frame,
  - rounded dotted cream canvas,
  - boxed serif logo,
  - oversized headline with inline restaurant imagery,
  - yellow/blue circles,
  - bottom fade and "Built for Restaurants" pill.
- MiniMax token-plan key is now live through:
  - `MINIMAX_API_BASE=https://api.minimax.io/v1`
  - `DEMO_MODEL=MiniMax-M2.7`
- Added guarded MiniMax responses so live chat stays specific to Pleasure Pizza, Tuesday slow windows, margin-safe offers, and compliance.
- Added file-backed state in `PIELOT_DATA_DIR` for:
  - users,
  - restaurant profile,
  - customers,
  - imports,
  - campaign metrics,
  - opt-outs,
  - audit logs.
- Added real backend endpoints for:
  - `POST /api/auth/login`
  - `GET /api/auth/me`
  - `GET/POST /api/restaurants/current`
  - `POST /api/customers/import`
  - `GET /api/customers`
  - `GET /api/data-validation`
  - `POST /api/sms/send`
  - `POST /api/sms/webhook`
  - `GET /api/campaigns/:id/metrics`
  - `GET /api/opt-outs`
  - `GET /api/audit-log`
- CSV import now parses rows, normalizes phone numbers, checks required fields, dedupes phones, counts opt-ins/missing consent, persists customers, and records audit events.
- Campaign approval, SMS webhook events, redemptions, opt-outs, and campaign metrics now persist to the state file.

### Not Done Yet
- Replace file-backed state with managed Postgres for durable multi-instance production.
- Wire real Twilio credentials and validated provider webhooks.
- Add password/OAuth auth instead of lightweight demo session login.
- Add full CSV file picker upload; current UI supports pasted CSV import.

## Update (May 30, 2026 - Easy Cloney UI Port)

### Done
- Pulled the `animvsh/easy-cloney-ui` reference and ported its fake-demo direction into the current Express app.
- Replaced the mixed older screen style with the cream/charcoal Pielot frame:
  - dark outer canvas,
  - dotted cream paper,
  - black framed cards,
  - dark app sidebar,
  - fake app dashboard,
  - fake customer data interactions.
- Added the uploaded Pielot logo image at `public/pielot-logo.png` and used it in the main nav.
- Added `/app` as a functional fake demo route.
- Verified locally in the in-app browser:
  - `/` renders the fake-demo landing and customer data,
  - `/app` renders the app preview and Run Autopilot adds activity,
  - `/agent` uses the fake-demo dark sidebar shell.
- Verified MiniMax locally:
  - `/api/provider-health` returns `mode=live`,
  - `/api/demo-chat` returns live MiniMax text with `DEMO_MODEL=MiniMax-M2.7`.

### Not Done Yet
- The MiniMax token is configured through environment variables only; do not commit it to GitHub.
- Railway should be redeployed after this commit so the public URL receives the new fake-demo UI.
