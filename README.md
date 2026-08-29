# Connecting Wall — on Render

Same stack as Tendwise: Node on Render with Postgres.

The web service serves both the game and its API from one origin, so there's
no CORS to configure and only one thing to deploy.

```
server.js        Express app — API + serves the game
public/index.html  the whole game (one file, no build step)
package.json     express + pg
render.yaml      blueprint: creates the service and database together
schema.sql       reference only — server.js applies this itself on boot
```

---

## Deploy

Push these to a repo, then in Render: **New → Blueprint** and point it at the
repo. `render.yaml` creates the web service and a Postgres instance and wires
`DATABASE_URL` between them.

Or by hand, if you'd rather:

1. **New → Postgres.** Name it, take the free plan, copy the Internal
   Database URL.
2. **New → Web Service**, same repo.
   - Build: `npm install`
   - Start: `npm start`
   - Health check path: `/healthz`
3. Add env var `DATABASE_URL` = the internal URL from step 1.
4. Deploy.

There is no migration step. The server creates its tables on boot with
`CREATE TABLE IF NOT EXISTS`, so a fresh database works immediately and an
existing one is left alone.

**Nothing in `index.html` needs editing.** It ships with `var BACKEND = ""`,
and the server rewrites that to `"same-origin"` as it serves the page. The same
untouched file therefore also works as a plain static upload anywhere else — it
just falls back to per-device storage when no server is rewriting it.

### Free plan

Render's free web services sleep after inactivity, so the first visit after a
quiet spell takes a few seconds to wake. Free Postgres instances also expire
after 90 days — fine for testing, worth moving to the paid tier or pointing
`DATABASE_URL` at an existing database if it sticks around.

---

## How it works

**Share links contain the puzzle.** A shared wall is base64-encoded JSON after
the `#` in the URL. Nothing is stored and nothing is looked up — the link *is*
the wall. That's why share links work with no backend at all, forever.

**Everything learned is an additive counter**, never an event log:

- Storage stays small and roughly fixed no matter how many people play
- Concurrent players merge with `ON CONFLICT DO UPDATE SET n = n + EXCLUDED.n`,
  so simultaneous writes can't clobber each other
- The trade-off: you can only answer questions the counters were built for, and
  a bad contribution can't be undone, because there's no history to roll back to

**Storage mode is picked at boot:**

| Situation | Behaviour |
|---|---|
| Served by this server | Shared via Postgres. Instant saves, no reloads. |
| Static upload elsewhere | That browser only. Fully playable. |
| Running inside Claude | Page republishes itself to save. |

If the database is unreachable the game still serves and falls back to
device-local storage rather than erroring.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | walls + learning, for page boot |
| POST | `/api/stats` | merge a batch of play counters |
| POST | `/api/walls` | replace the shared wall library |
| GET | `/healthz` | Render health check |

---

## What's guarded

`server.js` treats everything arriving from the internet as hostile: category
keys must match a strict pattern, every counter is clamped, and statistically
impossible submissions are dropped (a group solved more often than it was
shown, or a mean solve position outside 1–4). All SQL is parameterised.

There's no rate limiting. If it gets popular, put Cloudflare in front or add
`express-rate-limit` on `/api/`.

---

## Tuning the game

The category bank is a plain list near the top of the script in
`public/index.html`:

```js
{ tier:0, key:"planets", label:"Planets", items:["Mercury","Venus","Mars","Neptune"] },
```

`tier` is 0 Easy, 1 Medium, 2 Hard, 3 wordplay. `key` must be unique,
lowercase-with-hyphens, and is what the database counts against — so renaming a
key orphans its accumulated stats.

Below the bank is `DECOY_HINTS`: per item, which *other* categories that item
could be mistaken for. That map is where wall difficulty actually comes from.
Adding entries there improves the puzzles more than adding new categories does.
