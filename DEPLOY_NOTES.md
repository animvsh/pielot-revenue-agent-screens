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
