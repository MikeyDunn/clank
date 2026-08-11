# Clank

A **multi-platform, multi-tenant** bot that draws — and remembers. Clank generates
images from a prompt (Slack `/clank`, a Discord command, an iMessage extension),
but the interesting part is the **mind** behind it: an evolving identity, a
journal, and a relevance-searchable memory of everything a community has ever
built, all of which shape what he chooses to draw. Every community gets its own
isolated, persistent mind that grows the more it's used.

Built as a study in doing LLM application engineering *well*: structured model
I/O, relevance-based retrieval, prompt caching, atomic financial correctness for
paid credits, and a fully typed TypeScript codebase running on AWS Lambda —
across three platforms behind one shared core.

```
/clank draw a raccoon presenting quarterly earnings
        │
        ▼  (ack < 3s, then async)
  ┌─────────────┐   recall lore      ┌──────────────┐
  │   THINK     │ ◀───tools────────▶ │  S3 Vectors  │  relevance memory
  │  (Sonnet)   │                    └──────────────┘
  │ decide img/ │   identity, journal, people
  │ text, craft │ ◀──────────────────┐
  │ imagePrompt │                    │
  └──────┬──────┘              ┌──────────────┐
         │ submitResponse      │  DynamoDB    │  source of truth
         ▼ (structured)        └──────────────┘
  ┌─────────────┐
  │  GENERATE   │  the image model renders the imagePrompt — no context, "just the hands"
  │ (renderer)  │
  └──────┬──────┘
         ▼  posts directly to the channel
```

## Engineering highlights

- **Two-brain pipeline.** A reasoning model (Claude Sonnet) decides image-vs-text,
  recalls lore, and writes the `imagePrompt`; a cheaper image model renders it with
  *no* context. Personality has to survive the handoff by being encoded into the
  prompt itself — the design forces it into the art.
- **Structured outputs, not prose parsing.** The think step returns its answer
  through a `submitResponse` tool call, so constrained decoding guarantees the
  shape. No "find the JSON in the model's prose" regex, no parse-failure recovery.
- **Relevance memory over context-dumping.** Every prompt is embedded into AWS S3
  Vectors; Clank *recalls* relevant lore on demand via `getEntityLore` /
  `getSemanticLore` tools (with multi-hop), instead of stuffing recent history into
  the prompt. DynamoDB stays the source of truth.
- **Prompt caching** on the think step's large static prefix (`cache_control`) —
  the tool-calling loop re-reads it at ~1/10th the cost.
- **Evolving identity.** Every 50 interactions a reflection step rewrites Clank's
  self-portrait, carrying forward the durable core so traits compound over time,
  and produces *commitments* — concrete resolutions that get surfaced back on
  future requests, turning reflection into behavior (see *Does it actually
  evolve?* below).
- **One core, three platforms.** Slack, Discord, and an iMessage extension share a
  single `runArtPipeline` → `consumeOutcome` flow; each platform is a thin adapter.
  The memory logic is platform- *and* tenant-neutral behind a `MindStore` seam, so
  one brain serves every isolated community.
- **Atomic financial correctness.** Paid credits (Discord SKUs, iMessage StoreKit)
  run on a global per-user wallet where *every* operation is a single conditional
  DynamoDB write — spend can't go negative, grants are idempotent per transaction
  id, and chargebacks claw back the unspent remainder. No read-modify-write races.
- **Real TypeScript + ESM.** Strict-ish TypeScript (`tsc --noEmit`) gives full
  IntelliSense and CI type-safety; SST/esbuild does the build at deploy time, so
  there's no separate manual build command.

## Does it actually evolve? Yes — measurably.

"Evolving AI personality" is easy to claim and usually a fake progress bar. Clank's
is checkable, so I checked it. Embedding all ~40 stored identity snapshots and
measuring cosine distance over time:

- **Anchored drift, not a random walk.** Per-reflection change averages ~0.055 and
  stays flat (he hasn't converged), yet his oldest→newest distance is ~0.20 — about
  **86% of the largest gap between any two snapshots**, and well above the average
  pair. Net travel is ~30% of what free diffusion would produce: he moves a lot
  every cycle but stays near one center, and what survives is *directional*.
- **A commitment became a trait.** Tracking commitments across cycles, one
  resolution ("commit to a strong read; a wrong strong read beats a timid one")
  held for five cycles, then migrated out of the commitments list and into the
  core-identity text verbatim. Practice turned into personality — and nothing
  instructed it to.
- **A principle reached the work.** His "sincerity makes absurdism land" idea shows
  up in private per-request reasoning 0.9% of the time at launch, 20% five months
  later — an aesthetic opinion measurably becoming a working method.

The takeaway that drove the design: *you can't improve a personality you aren't
measuring.* Judging reflections by whether they "read well" produces beautiful
rumination; measuring drift and commitment-follow-through produces actual change.

## Stack & why

| Choice | Why |
|---|---|
| **AWS Lambda + SST (Ion)** | Event-driven, scales to zero, no servers to run; infra as TypeScript |
| **DynamoDB single-table + GSI** | One round-trip for the mind; atomic writes, no race conditions |
| **S3 Vectors** | AWS-native vector store — relevance recall without a separate DB |
| **OpenRouter** | One API for Sonnet (reasoning), an image model, and embeddings |
| **Biome** | Lint + format in one fast tool |
| **TypeScript + ESM** | Real types at dynamic boundaries; esbuild builds at deploy |
| **`node:test` via tsx** | Built-in test runner, run straight off `.ts` — minimal deps |

## Develop

```bash
npm install
cp .env.example .env        # fill in keys
npm run check               # lint + typecheck + test (CI runs this on every PR)
npm run deploy:dev          # sst deploy --stage dev
```

`npm run dev` runs `sst dev` for live local development.

Layout: `src/handlers/` are the Lambda entry points, `src/lib/` is the
implementation, `test/` holds unit tests. See [docs/DEPLOY.md](./docs/DEPLOY.md) to deploy your own, [AGENTS.md](./AGENTS.md) for
conventions and [CLAUDE.md](./CLAUDE.md) for the full design rationale.

## What makes it fun

Clank isn't scripted — his personality *emerged* from use. The group's running
jokes became his lore; his self-image is rewritten by his own reflections; when
his hands won't render something he reacts in character. The memory system means
a character invented in one prompt can resurface, consistent, weeks later. It's a
small, genuine attempt at an AI with continuity instead of a stateless prompt.
