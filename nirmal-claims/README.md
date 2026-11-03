# Nirmal Claims

Warranty-claims app for Nirmal Home Appliances, built from the Day 7 App Build Guide.
Real frontend, real backend, real database. No npm packages, no internet, no live AI calls.

## Run it

Needs **Node 22.5 or newer** (uses the built-in SQLite).

```
node server.js          # or: npm start
```

Open http://localhost:3000. The database (`data/nirmal.db`) is created and seeded with the 20 claims on first start.
Use another port with `PORT=4000 node server.js`.

Run the automated checks (starts its own server and throwaway database): `npm test`

## How the pieces connect

```
 browser (public/)  --- fetch /api/* --->  server.js  --- SQL --->  data/nirmal.db
   index.html                               rules.js (routing policy)    claims, decisions,
   style.css                                seed.js  (20 claims, users)  audit, settings, users
   app.js    <--- SSE /api/events (live) ---
```

The routing rules, reason rule, approval limits and audit trail all run on the **server**, so the browser cannot skip them.
Open the app in two windows: a decision in one appears in the other within a moment (green "live" light, top right).

## Guide steps and where they live

| Guide step | Where |
|---|---|
| 1 Routing rules | `rules.js` `routeClaim()` |
| 2 Queues with counts | `GET /api/claims` returns `queueCounts`; `renderQueues()` / `renderTable()` |
| 3 Claim detail | `renderDetail()` (incl. "Approver needed", policy 9.4 warning, "Why this queue") |
| 4 Decisions + reason rule | `POST /api/claims/:id/decision` |
| 5 Threshold slider | header slider, `PUT /api/settings` (0.70 to 0.95, saved in the database) |
| 6 Audit log + CSV | Audit log tab, `GET /api/audit`, `GET /api/audit.csv` |
| 7 Dashboard tiles | six tiles from `GET /api/dashboard`, plus a Dashboard tab with charts |
| 8 Easy to use | Reset demo, approval limits by role, search, helpful messages, status colours, why this queue, phone layout, next-claim after a decision |
| 9 Make it yours | change `rules.js` (thresholds, limits) and `seed.js` |

Extra: **New claim** form (duplicate detection by serial + job date, simple stand-in pre-screen instead of a live AI).

## People and limits

Pick who you are in the header. Approving is limited by role (policy 8); rejecting and sending back are not.

| Name | Role | Can approve up to |
|---|---|---|
| Anita Rao (default) | Warranty executive | 5,000 |
| Vikram Sethi | Desk Lead | 25,000 |
| Meera Iyer | Head of Customer Service | any amount |

## API

| Method and path | Purpose |
|---|---|
| `GET /api/claims` | all claims with queue, why, approver, decision, plus counts and threshold |
| `GET /api/claims/:id` | one claim |
| `POST /api/claims` | create a claim (422 with per-field `errors` if invalid) |
| `POST /api/claims/:id/decision` | `{action, reason, user_id}`; 422 reason missing, 403 over limit, 409 already decided |
| `PUT /api/settings` | `{threshold}` |
| `GET /api/dashboard` | tiles and chart data |
| `GET /api/audit`, `GET /api/audit.csv` | audit log (newest first) / CSV download (oldest first, every value quoted) |
| `POST /api/reset` | clear decisions, audit, added claims; threshold back to 0.85 |
| `GET /api/events` | live updates (server-sent events) |

## The checks from the guide

All eight are covered by `npm test`: routing for 5004/5011/5006/5001/5005/5014, queue counts at 0.85
(7 / 6 / 3 / 2 / 2), the 5001 and 5017 detail data, approve 5012 without a reason, reject 5001 without one,
threshold 0.90 and 0.80, two decisions then CSV, approve 5002 and reject 5003 (18 waiting, 1,100, 50%), and reset.

## Good to know

- The data lives in `data/nirmal.db`. Delete the file to start completely fresh, or use **Reset demo**.
- The guide's "one HTML file, opens by double-click" rule is for the in-class build. This version is the full-stack one,
  so it needs `node server.js` running.
