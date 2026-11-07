# skeleton

An automated hunting bot for [RavenBlack Vampires](https://quiz.ravenblack.net/blood.pl),
written in TypeScript (Node.js, ESM). It logs in, sweeps the 200×200 city map, drinks
from humans and vampires, fights hunters, and exposes Prometheus metrics.

> Internal design notes — game mechanics, HTML-parsing quirks, and sweep strategy —
> live in [`CLAUDE.md`](./CLAUDE.md).

## Quick start

```bash
npm install
cp .env.example .env          # set VAMPIRE_NAME and VAMPIRE_PASS

# dev run (don't wait for full AP, stop when AP is spent)
WAIT_FOR_FULL_AP=false SINGLE_RUN=true npm start
```

## Scripts

| Script                            | Purpose                       |
| --------------------------------- | ----------------------------- |
| `npm start`                       | Run from source with `tsx`    |
| `npm run build`                   | Compile TypeScript to `dist/` |
| `npm run start:prod`              | Run the compiled build        |
| `npm run typecheck`               | `tsc --noEmit`                |
| `npm run lint`                    | ESLint                        |
| `npm run format` / `format:check` | Prettier                      |
| `npm test`                        | Vitest unit tests             |

## Environment variables

| Variable                                  | Default         | Notes                                          |
| ----------------------------------------- | --------------- | ---------------------------------------------- |
| `VAMPIRE_NAME`                            | —               | required                                       |
| `VAMPIRE_PASS`                            | —               | required                                       |
| `VAMPIRE_COOKIE_PQ` / `VAMPIRE_COOKIE_IP` | —               | optional injected session cookies (Docker/K8s) |
| `WAIT_FOR_FULL_AP`                        | `true`          | wait for full AP before sweeping               |
| `SINGLE_RUN`                              | `false`         | exit once AP is exhausted (for CronJob use)    |
| `SWEEP_DELAY`                             | `3`             | seconds between ticks (min 3)                  |
| `METRICS_PORT`                            | `8080`          | Prometheus metrics server port                 |
| `DATABASE_URL`                            | —               | optional PostgreSQL; enables hunt logging      |
| `COOKIE_FILE`                             | `.cookies.json` | session cookie store                           |

## Docker

```bash
docker build -t skeleton .
docker run --rm -e VAMPIRE_NAME=... -e VAMPIRE_PASS=... -v "$PWD/data:/data" skeleton
```

The image runs as the unprivileged `node` user and persists its cookie to `/data`.
Metrics are served on `:8080/metrics`; a Grafana dashboard is in
[`grafana-dashboard.json`](./grafana-dashboard.json).

> **Note:** the anti-bot challenge needs an interactive terminal to solve. In a headless
> deployment, inject a pre-authenticated session cookie (`VAMPIRE_COOKIE_PQ`/`IP`); if a
> challenge appears with no TTY the process exits with a clear error rather than hanging.

## License

[MIT](./LICENSE)
