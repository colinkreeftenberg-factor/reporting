# Factor Error Dashboard — project notes

## What this is
A static dashboard (no build step) + one Vercel serverless function for comments.
- Frontend: `index.html` + `app.js`, `components.js`, `data.js`, `pages.js`, `filters.js`, `comments.js`
- API: `api/comments.js` — GET/POST/DELETE comments, backed by Upstash Redis (`@upstash/redis`)
- Deployed on Vercel, auto-deploys from GitHub `main`.

## Deployment / hosting
- GitHub: `origin` → https://github.com/colinkreeftenberg-factor/reporting
- Vercel project: **`factor-eu/reporting`** (team scope is `factor-eu`, NOT personal)
- Live URL: https://reporting-orpin.vercel.app
- Push to `main` → Vercel auto-deploys.

## Vercel CLI workflow
- CLI is not installed globally (no sudo). Use **`npx --yes vercel@latest ...`**.
- Always pass **`--scope factor-eu`** (the project is under the team, not personal).
- Repo is already linked (`.vercel/project.json` present).
- Local dev: `npx vercel@latest dev --listen 3000 --scope factor-eu`
  - Static frontend serves fine locally (HTTP 200) — use this to preview UI edits.
  - Debug endpoint: `GET /api/comments?debug=1` reports whether Redis creds are visible.

## Sensitive-env caveat (important)
- Redis creds (`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `REDIS_URL`, etc.) are marked
  **"Sensitive"** in Vercel and exist only in **Preview + Production** (not Development).
- `vercel env pull` brings them down as the literal placeholder `"[SENSITIVE]"`, so the
  **comments API cannot reach Redis in local `vercel dev`**.
- To test comments end-to-end: use the live/preview deploy, OR paste real Upstash creds
  into `.env.local` manually (gitignored). Claude should not type API tokens itself.
- For most edits (frontend-heavy) local preview is enough; comments feature verified on deploy.

## Working style to save credits
- Make surgical Edits to real files; don't reprint whole files.
- Preview frontend locally before pushing; commit + push only when asked.
