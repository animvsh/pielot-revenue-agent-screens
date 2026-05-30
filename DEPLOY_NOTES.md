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
