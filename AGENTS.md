# AGENTS.md

Instructions for AI coding agents working in this repo. (Vendor-neutral; see
[CLAUDE.md](./CLAUDE.md) for the deeper design philosophy and project history.)

## What this is

Clank is a Slack bot that generates images via OpenRouter and keeps an evolving
"mind" (identity + journal + vector memory) in DynamoDB and S3 Vectors. It runs
on AWS Lambda, deployed with SST (Ion), written in TypeScript (ESM); SST/esbuild
builds at deploy time.

## Before you finish: run the checks

```bash
npm run check      # lint + typecheck + tests — must be green before you're done
```

Individually: `npm run lint` (Biome), `npm run typecheck` (`tsc --noEmit`),
`npm test` (`node:test` via tsx). Auto-fix formatting/lint with `npm run lint:fix`.

## Conventions

- **TypeScript + ESM** (`tsconfig.json`). Every source file is `.ts`; relative
  imports keep `.js` specifiers (correct for TS+ESM). SST/esbuild builds at deploy,
  so there's no separate manual build step. Strict minus `noImplicitAny` /
  `useUnknownInCatchVariables`; `any` is a deliberate choice at dynamic boundaries
  (DynamoDB items, axios responses), so Biome's `noExplicitAny` is off.
- **Formatting + linting is Biome** (`biome.json`): 4-space indent, single quotes.
  Don't hand-format — run `npm run lint:fix`.
- **4-space indent, await every async call, never crash the Lambda** (wrap I/O in
  try/catch with `console.error`).
- **Pure logic lives apart from I/O** so it's testable — when you add branching
  logic to an I/O function, consider extracting the pure core (see
  `src/lib/imageProcessor/productName.ts`) and unit-testing it.
- **Keep the typecheck green** — see the strictness settings in `tsconfig.json`.

## Layout

```
src/handlers/   the 4 Lambda entry points — the ONLY things sst.config.ts calls
src/lib/        implementation (memory/, imageProcessor/, platform/, ...)
src/lib/platform/  external-platform adapters (slack.ts)
scripts/        recurring ops tools (own DynamoDB clients; do NOT import src/lib)
test/           node:test unit tests for the pure surface
```

Rule of thumb: **root = project config, `src/` = code, `src/handlers/` = the deploy
surface.**

## Deploy

```bash
npm run deploy:dev    # sst deploy --stage dev (AWS profile from .env)
```

## Design guardrails (don't revert)

Clank's personality is emergent, not hardcoded; lore is user-authored; appearance
data is manual-only (troll-safe). Full rationale in [CLAUDE.md](./CLAUDE.md) →
"Known Decisions".
