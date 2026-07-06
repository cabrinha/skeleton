# skeleton — Vampire Bot

Automated hunting bot for [RavenBlack Vampires](https://quiz.ravenblack.net/blood.pl).
Plays as **Vespertine**. TypeScript/Node.js, ESM, `tsx` for dev.

## Game mechanics

- **Map**: 200×200 grid, coordinates 1–200 on each axis. City Limits at edges (can't enter).
- **AP**: max 90, 1 AP per 15 min. Every move or drink costs 1 AP.
- **Targets**:
  - Vampires: drink via GET `?action=drink&target=Name&z=TOKEN` (z-token required)
  - Humans: drink via POST `action=drink&t=0|0` (NOT `target=`, it's `t=`)
- **Per-cell drain**: once you've drunk from a target, they're "drained" at that position until they move. Track this to avoid retry loops.
- **Hunters**: enemy vampires with fight links — fight before sweeping.
- **Z-token**: session CSRF token in all nav links (`?z=...`). Required for GET drink, not for POST moves.

## HTML quirks (critical for parsing)

- **Current cell**: the center `<td>` with **no** `input[name="x"]`. Contains `<b>VampireName</b>`.
- **City Limits cells**: `<td class="cityblock">` at map edges ALSO have no `input[name="x"]`. The parser must skip them (by class or `(City Limits)` text) — otherwise every one collapses onto the current-cell key `(cx,cy)` and an empty edge cell clobbers the real current cell, wiping out its human/drink target. This was the "seen but not drunk near the border" bug.
- **Adjacent cells**: have a move form with `input[name="x"]` and `input[name="y"]`.
- **Vampire in cell**: `<a href*="viewvamp=Name">` link + drink GET link with `action=drink&target=Name`.
- **Human in current cell**: `<span class="human">Human</span>` + POST form with `input[name="action" value="drink"]` and `input[name="t" value="0|0"]`.
- **Human in adjacent cell**: `<span class="human">Human</span>` only — no form.
- **Human detection**: read `td span.human` directly. Do NOT strip forms/links and scan leftover text — that counts our own `<b>Name</b>` (and bold vampire names) as a phantom human in the current cell.
- **Position**: median of unique sorted `input[name="x"]` values across all move forms.
- **AP**: text node `"Action Points: 81/90"` inside a bordered `<div>`.
- **Anti-bot**: JS call `anti_robot(Array("hex",...), 'pixels', 'fieldName')` — decode pixel data, render as PNG, get user input, POST `action=robot&fieldName=answer`. After clearing, **retry the original request** (gate clears but does not re-authenticate).

## Sweep strategy

- **No targets visible**: move diagonally (NE/SE/NW/SW) to reveal the most new squares per move.
- **Targets visible in adjacent cells**: move directly to the highest-scoring cell (no forced diagonal).
- **Scoring**: `humans × 10 + vampires × 3` — prioritise human clusters.
- **Direction**: `dirX` (±1 east/west) + `dirY` (±1 NE/SE). Bounce on y-boundary (1 or 200). Reverse `dirX` when a move is rejected by the server (City Limits detected by position not changing after move).
- **After every move**: immediately evaluate the new cell for targets and drink without waiting for the next tick.

## File map

| File | Purpose |
|---|---|
| `src/main.ts` | Entry: metrics → DB → session → login → Hunter.run |
| `src/config.ts` | All env vars and constants |
| `src/session.ts` | axios + tough-cookie HTTP client, cookie persistence, anti-bot solver |
| `src/bot.ts` | Login, move, drink, fight — all return `PageState` |
| `src/parser.ts` | Cheerio HTML → `PageState` + `CellInfo` grid |
| `src/location.ts` | `(x,y)` → street name (e.g. `Zestless & 2nd`) for logs. Odd x → `STREET_NAMES[(x-1)/2]`, odd y → `(y+1)/2`. Verified vs live `span.intersect` labels; NOT city-crawler's off-by-one formula. |
| `src/hunter.ts` | Sweep logic, target scoring, AP sleep, drained tracking |
| `src/db.ts` | Optional PostgreSQL logging (`skeleton_hunt_log` table only) |
| `src/metrics.ts` | Prometheus metrics server on `:8080` |

## Running

```bash
# dev
WAIT_FOR_FULL_AP=false npm start

# skip AP wait and stop after AP exhausted
WAIT_FOR_FULL_AP=false SINGLE_RUN=true npm start

# type-check
npx tsc --noEmit
```

## Environment variables

```
VAMPIRE_NAME=       # required
VAMPIRE_PASS=       # required
VAMPIRE_COOKIE_PQ=  # optional, injected session cookie (Docker/K8s)
VAMPIRE_COOKIE_IP=  # optional, injected session cookie (Docker/K8s)
WAIT_FOR_FULL_AP=   # default true — wait for full AP before sweep
SINGLE_RUN=         # default false — exit after AP exhausted
SWEEP_DELAY=        # seconds between ticks (default 3, min 3)
METRICS_PORT=       # default 8080
DATABASE_URL=       # optional PostgreSQL — enables hunt logging
COOKIE_FILE=        # default .cookies.json
```

## Database

Only writes to `skeleton_hunt_log`. Never touches city-crawler tables.
Shares the same PostgreSQL instance as city-crawler (vampires.terrible.engineering) — that is a public site, skeleton must never write to its tables.

## Known issues / things to verify

- **Human detection**: parser reads `td span.human`. Verify with `logGrid()` output that humans appear when visible and that the current cell does NOT show a phantom human.
- **Anti-bot image path**: logged as `[anti-bot] Image: <path>` — path occasionally appears blank in terminal output but image still opens.
- **City Limits**: detected by position not changing after a move attempt. `dirX` reverses on detection.

## Related repos

- `city-crawler` at `../city-crawler` — public React map app (vampires.terrible.engineering). Shares DB but must remain separate. Navigation util: `src/services/navigation.ts` (Chebyshev distance). City data: `src/data/cityData.ts` (200 streets, buildings, transit, banks).
