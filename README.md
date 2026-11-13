# SEA Rematch League (SRL)

Community league hub for SEA **REMATCH**: live standings, player & team stats, fixtures, playoffs, cups, awards, player and team pages, and a full admin console. Runs on **one Firebase project on the free Spark plan** (Hosting, Firestore, Auth) plus a small **Cloudflare Worker** on the Workers free plan, with **Discord as the only sign-in**.

Built from `sea-rm design document.pdf` (spec §1–8). Fantasy features are intentionally excluded.

```
sea-rm/
├─ src/                    React + TypeScript SPA (Vite)
│  ├─ pages/               #home #table #stats #fixtures #cups #cup #awards #player/<id> #teams #team/<id> #me (sign-in & player setup)
│  ├─ admin/               #admin — Match Day, League, Season, Moves, Content, System
│  ├─ modals/              Match, Leaderboard, Comparison popups
│  ├─ components/          Top bar, mobile nav, search, page header, table, cards, bracket, charts
│  └─ lib/                 Firebase init, op router (call), audited writes (db.ts), Discord OAuth, hooks
├─ core/                   League operations shared by the Worker and the admin's browser
│  ├─ firestore.ts         Tiny Firestore REST client (firebase-admin-style API, web APIs only)
│  ├─ index.ts             Which ops run in the Worker vs. the browser
│  └─ shared/league.ts     Pure league maths
├─ worker/                 Cloudflare Worker: /api/<op>, /interactions
├─ scripts/seed.ts         1 season · 10 teams · 50 players · double round-robin · 5 results
├─ tests/rules.test.ts     Firestore security rules tests
└─ firestore.rules · firestore.indexes.json · firebase.json · public/ (PWA)
```

`core/shared/league.ts` holds the pure league maths (series rules, standings, tiebreakers, stats, leaders, power rankings, round-robin, bracket engine). The client also uses it for bracket drawing.

### Why a Worker? (free-plan architecture)

The Spark plan has **no Cloud Functions and no Cloud Storage**. The old functions are now *operations* in `core/`, split by where they can safely run:

| Runs in | Operations | Why |
|---|---|---|
| **Cloudflare Worker** (service account) | Discord sign-in, claims, player setup, admin player↔Discord linking, transfer requests, kickoff times, threads, slash commands, role sync, avatars, webhooks (results, rules), visitor count | Needs a secret (Discord client secret, bot token, webhook URLs) or must be trusted across users |
| **Admin's browser** (their own login; rules enforce `role: admin/owner`) | Recompute standings/stats/brackets/records, generate schedule, new-season wizard, Wrapped, admin transfers, backup, restore, merge duplicates | Heavy jobs that would exceed the Worker free plan's 50 subrequests / 10 ms CPU per request |

Firestore triggers don't exist without Functions either, so the browser now calls the follow-up steps itself. For example, saving a result runs `afterMatchWrite` (recompute) and then the Worker's `matchSideEffects` (Discord result post). Images (team crests, match screenshots) are **links**, e.g. a Discord attachment's *Copy link*, because Storage isn't available.

---

## 1. Prerequisites

- Node.js **22+** and npm
- Java **21+** JDK for the Firestore emulator (firebase-tools 15 refuses older Java), e.g. `winget install EclipseAdoptium.Temurin.21.JDK`
- One Firebase project on the **Spark (free)** plan. The ID is `srl-dev` throughout; if yours differs, change it in `.firebaserc`, `worker/wrangler.toml` (`FIREBASE_PROJECT_ID`) and `.env.production`.
- A free Cloudflare account (for the Worker)

## 2. Run locally with the Emulator Suite

```bash
npm install
cp .env.example .env.local                    # VITE_USE_EMULATORS=true is the default
cp worker/.dev.vars.example worker/.dev.vars  # Discord secrets optional for local dev

npm run emulators        # terminal 1: Auth + Firestore emulators, UI on :4000
npm run worker           # terminal 2: the Worker on http://localhost:8787 (talks to the emulators)
npm run seed             # terminal 3: wipes the emulator DB and loads sample data
npm run dev              # terminal 3: app on http://localhost:5000
```

**Signing in locally without Discord:** with `VITE_USE_EMULATORS=true` a 🧪 button sits next to *Sign in*. It signs into the Auth emulator as one of the seeded accounts:

| Account | UID | What to test |
|---|---|---|
| Dev owner | `discord:100000000000000001` | Admin Panel, owner-only tools (merge, restore, admins) |
| Dev user | `discord:100000000000000002` | First sign-in → straight to **Set up your player** (creates a free agent) |
| Dev captain | `discord:100000000000000003` | Captain tools on their team's page and the match screen (requests, kickoff times) |

Real Discord sign-in also works locally once the Discord app below is configured and `worker/.dev.vars` has `DISCORD_CLIENT_SECRET`.

Rules tests: `npm run test:rules` (boots the Firestore emulator and runs Vitest).

## 3. Discord application setup

Application ID **1569644221718331412**, guild **1562776724431831050** (already wired as defaults in `worker/wrangler.toml`).

1. **OAuth2 → Redirects**: add
   - `https://<project-id>.web.app/auth/callback`
   - `https://<project-id>.firebaseapp.com/auth/callback`
   - `http://localhost:5000/auth/callback`
   - plus any custom domain, and list it in `ALLOWED_REDIRECTS` in `worker/wrangler.toml`.
2. **OAuth2 scopes** used by the site: `identify guilds.members.read` (the second reads the member's server roles so the admin roles apply).
3. **Bot**: create a bot, copy its token. Invite it to the server with scopes `bot applications.commands` and permissions **Manage Roles, Manage Threads, Create Public Threads, Send Messages, Send Messages in Threads, Read Message History, Embed Links**. Put the bot's role **above** every team role or role sync fails.
4. **Privileged intents**: enable **Server Members Intent** (lets *Sync roles* remove stale team roles).
5. **General Information → Interactions Endpoint URL**: `https://<your-worker>.workers.dev/interactions` (set after deploying the Worker, §4). Copy the **Public Key**.
6. Create webhooks in Discord for results and rules, then paste them in *Admin → Settings → Webhooks* (stored in `private/discord`, Worker-write only).
7. In *Admin → Settings → Discord & roles* fill the match-report channel, then click **Register slash commands** (`/standings`, `/next`).

Admin role IDs `1562781903604424794, 1563169917384134827` grant admin automatically (editable in *Settings → Admins*).

## 4. Deploy (one Firebase project + one Worker, both free)

**Firebase**
1. Create the project (Spark plan), then create the Firestore database (any region; `asia-southeast1` is closest to SEA).
2. Authentication → enable it (no providers needed; sign-in uses custom tokens).
3. Project settings → Service accounts → **Generate new private key**. Keep the JSON safe; it goes into the Worker in the next step and never into the website.
4. Project settings → Your apps → add a **Web app** and copy its config into `.env.production` (same keys as `.env.example`) with `VITE_USE_EMULATORS=false`.

**Cloudflare Worker**
5. `npx wrangler login`
6. Set the secrets (each command prompts for the value; paste the whole service-account JSON for the first):
   ```bash
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT --config worker/wrangler.toml
   npx wrangler secret put DISCORD_CLIENT_SECRET   --config worker/wrangler.toml
   npx wrangler secret put DISCORD_BOT_TOKEN       --config worker/wrangler.toml
   npx wrangler secret put DISCORD_PUBLIC_KEY      --config worker/wrangler.toml
   ```
7. `npm run deploy:worker`. Note the `https://srl-api.<you>.workers.dev` URL, put it in `.env.production` as `VITE_API_URL`, and set it as the Discord Interactions Endpoint (§3.5). Optionally lock `ALLOWED_ORIGINS` in `worker/wrangler.toml` to your site and redeploy.

**Site**
8. `npm run deploy` (builds the SPA, deploys Hosting, Firestore rules and indexes).
9. **Bootstrap the first owner**: sign in once with Discord, then in the Firestore console create `settings/admins` = `{ ownerUids: ["discord:<your id>"], adminUids: [], adminRoleIds: [...] }`. Sign out and back in. From then on manage admins in *Admin → Settings → Admins*.
10. Optional seed of a real project: `SEED_PROD=1 GOOGLE_APPLICATION_CREDENTIALS=key.json GCLOUD_PROJECT=srl-dev npm run seed` (does **not** wipe; only use on an empty project).

## 5. How it works

- **Auth**: client → `discord.com/oauth2/authorize` (state in `sessionStorage`, `prompt=none`) → `/auth/callback` → Worker `discordAuth` exchanges the code with the secret, reads `/users/@me` and guild roles, upserts `users/discord:<id>`, sets custom claims `{ role: owner|admin|user }` via the Identity Toolkit API, and returns a custom token signed with the service account. The Discord access token never reaches the browser. `refreshClaims` recomputes after admin changes.
- **Players**: every league player signs in with Discord, and their player is tied to that account. First sign-in goes straight to *Set up your player*: the Worker's `setupPlayer` adopts a player an admin already linked to that Discord ID (*Admin → League → Players*), or creates a new free agent. Later sign-ins go to the player's own page. There is no self-claiming of existing players; admins link old records to Discord accounts instead.
- **Results**: admins enter a series game by game (*Admin → Add Result*). The browser then runs `afterMatchWrite`: it normalises the series (`leadBy2`: game 3 at 1–1, game 4 at 2–1, game 5 at 2–2), flags anything odd for review, and recomputes standings, player and team stats, leaders, positions, all-time records and brackets. Then the Worker posts the result webhook (first post or "✏️ Updated", tracked per match).
- **Brackets**: drawn from the table using `seasons.finalsFormat` (defaults: 1–2 bye to QF, 3–6 straight to QF, 7–10 wildcard). Every recompute rebuilds winners from scratch, so deleting a result rolls the bracket back.
- **Schedule**: `generateSchedule` uses the circle method (byes for odd counts, per-division with shared round numbers). *Top up* only adds missing pairings, packed into new rounds.
- **Audit log**: every write to an audited path commits an `auditLog` entry in the same atomic batch (`src/lib/db.ts`) with before/after and a field diff. Rules only accept entries stamped with the writer's own uid, and nobody (not even owners) can edit or delete them. Worker actions add audit notes.
- **Cups**: *Admin → Season → Cups* creates single-elimination cups (random or ticked-order draw, byes advance automatically) and can redraw a cup until its first result. Captains set cup kickoff times from the match screen.
- **Screenshots**: one per match, set by either team's captain or an admin. Discord attachment links are stored without their expiring signature and shown through the Worker's `GET /discord-image?u=…`, which re-signs them with the bot token (`/attachments/refresh-urls`).
- **Backups**: *Admin → System → Back up now* stores a restore point (chunked into `restorePoints/{id}/chunks`) and downloads the same data as a JSON file. Keep those files somewhere safe. *Restore missing* (owner) re-creates only documents that no longer exist, from a stored point or an uploaded file.
- **Paging**: Worker jobs that touch many Discord objects (role sync, avatars, thread publishing) work in pages of ~30 calls; the browser repeats the call until done.

### Free-plan limits to know

- **Firestore (Spark)**: 50k reads, 20k writes and 20k deletes per day, 1 GiB stored. A result save recomputes the season and records, typically a few hundred reads. A backup reads every document once.
- **Workers free**: 100k requests per day, 50 subrequests and 10 ms CPU per request. The heavy jobs run in the browser for this reason.
- **No automatic nightly backup** (that needed Cloud Functions + Storage). Take a manual backup before big admin actions; *Merge duplicates* takes one automatically.

## 6. Spec values filled in

| Item | Value |
|---|---|
| `--accent` / `--accent-2` | `#033c93` / `#1D8ADE` |
| `--zone-champion` / `--zone-finals` / `--zone-bye` / `--live` | `#eab308` / `#1D8ADE` / `#8b5cf6` / `#ef4444` |
| Display / body font | Barlow Condensed 700–800 / Inter 400–600, tabular numbers in tables |
| Radius · spacing · motion | 10 px (6 px small) · 4 px base · 150 ms ease-out |
| Tagline | Live standings, stats & fixtures |
| Logo / icons | `public/icons/logo.png` (the SRL server icon, 512 px) |
| Region | Firestore in `asia-southeast1` recommended; backups are manual on the free plan |

**Still to supply:** an SVG/WebP wordmark, a 1200×630 `public/icons/og.jpg`, a 192 px icon, a YouTube link (`VITE_YOUTUBE_URL`) and your Firebase project ID.

## 7. Notes and limits

- The self-serve position list uses the spec enum `GK, DF, MF, WF, ST, UNSURE` with labels Goalkeeper, Defender, Midfielder, Wing Forward, Striker and Not sure.
- `Recap` from the spec is covered by per-player **Wrapped** (on #me) and the pinned season celebration on Home.
- Each Firestore listener in the client loads a whole season (matches, rosters, players, teams). That's fine for a community league of this size; if the league grows to thousands of players, page the players list.
- Role removal during *Sync roles* needs the Server Members intent; without it, only additions happen.
- Not yet measured: Lighthouse mobile score (target ≥ 85). The layout is designed for 360 px wide.
