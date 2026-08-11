# Clank

## Project Summary
Clank is a **multi-platform, multi-tenant** image-generation bot. On Slack he answers `/clank`, the "Ask Clank" shortcut, and 👕/🤖 reactions; on Discord he answers `/clank`, a "Clank It" message context-menu command, and `/credits` (paid credit packs). He runs on AWS Lambda (deployed with SST) and uses OpenRouter for image generation + introspection. Each community gets its own persistent "mind" (DynamoDB + S3 Vectors) that evolves through interactions and periodic self-reflection. The original Slack group runs on `clank-mind-dev` (untenanted); every other community is a tenant on the shared `clank-mind-prod` store, fully isolated. See **Multi-Tenancy** below.

> **Deploying your own?** This is the public engineering doc. Instance-specific
> infra, secrets, and support runbooks live in a gitignored `CLAUDE.local.md`
> (auto-loaded locally). Resource names below (`clank-mind-*`, bucket names,
> `api.<your-domain>`) are the reference deployment — rename for your own.

## Collaboration Style
The goal is an organic, evolving AI personality — not a feature checklist. When a suggestion is made, **push back honestly** if it could hurt that goal. Explain the tradeoff, propose a better alternative, and only implement what actually improves things. Don't just say yes to ideas that sound reasonable but would degrade Clank's memory, personality coherence, or prompt quality. Protecting the design matters more than being agreeable.

## Architecture

### Infrastructure
- **Runtime**: Node.js 22.x on AWS Lambda, deployed with SST (Ion, the `sst` npm package v4); infra defined in `sst.config.ts`. SST manages the compute (Lambdas, REST API, custom domain, public images bucket); the **DynamoDB tables and S3 Vectors buckets are referenced externally by name + IAM**, NOT created by SST — so the data is never at risk on a deploy/remove.
- **AWS Profile**: `<your-aws-profile>`, region `us-east-1`
- **DynamoDB Tables** (PAY_PER_REQUEST, single-table, `pk`/`sk` + `gsi1`): `clank-mind-dev` (the Slack group, untenanted) + `clank-mind-prod` (multi-tenant: Discord now, migrated-Slack later). Identical schema. Both referenced externally.
- **S3 Vectors**: `clank-memory-vectors-dev`/`clank-memory` (Slack) + `clank-memory-vectors-prod`/`clank-memory` (tenants). 1536-dim cosine, `text` non-filterable. Referenced externally.
- **S3 Bucket**: `clank-image-generator-images-dev` (generated images, shared by all tenants) — created/managed by SST
- **Domain**: `api.<your-domain>` (custom domain via SST)
- **Website**: `<your-site>` (landing + `/terms.html` + `/privacy.html`), a static SST `site` stage (S3+CloudFront+ACM, Route 53 DNS; `npm run deploy:site`). `contact@<your-site>` forwards to Gmail via SES (`ops/email-forwarder/`). App is verified; monetization + the 3 credit SKUs are live.
- **Environment** (`.env`): `OPENROUTER_API_KEY` (Slack account), `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `PRINTIFY_API_KEY`, `DISCORD_APP_ID`/`DISCORD_PUBLIC_KEY`/`DISCORD_BOT_TOKEN`, `DISCORD_OPENROUTER_API_KEY` (Discord's SEPARATE OpenRouter account — its own billing/Auto-Recharge; the DiscordProcessor points its `OPENROUTER_API_KEY` at this, falling back to the Slack key until set), `AWS_PROFILE`. Discord Lambdas also get `PROD_DYNAMODB_TABLE_NAME`/`PROD_VECTOR_BUCKET`/`PROD_VECTOR_INDEX`. iMessage adds `IMESSAGE_TOKEN_SECRET` (HS256 session+draft JWTs), `IMESSAGE_DEV_AUTH` (opt-in flag for simulator dev auth, default off) + `IMESSAGE_DEV_KEY` (the dev-auth shared key; the branch is dead unless the flag is '1'), `IMESSAGE_BUNDLE_IDS` (SIWA aud allowlist).
- **SDK packages**: `@aws-sdk/client-{dynamodb,s3vectors,s3,lambda}`, `@aws-sdk/lib-dynamodb`, `electrodb` (prod entities), `@slack/web-api`, `discord-interactions` + `@discordjs/rest` (Discord adapter)

### Lambda Functions
| Function | Handler | Timeout | Purpose |
|----------|---------|---------|---------|
| `slackImageCommand` | `src/handlers/slack/slashCommand.slackImageCommand` | 30s | Entry point for `/clank` slash command |
| `slackInteraction` | `src/handlers/slack/interactions.handleInteraction` | 30s | "Ask Clank" / "Make T-Shirt" message shortcuts + Ask Clank modal submission (no buttons — results post directly) |
| `slackEvents` | `src/handlers/slack/events.handleEvent` | 10s | Events API — 👕 reactions → t-shirt; 🤖 reaction → respond to the reacted message |
| `imageProcessor` | `src/handlers/slack/processor.processImage` | 300s | Async (Slack): think (with lore tools) → generate → deliver |
| Discord interactions | `src/handlers/discord/interactions.handleDiscordInteraction` | 10s | `POST /discord/interactions` — Ed25519 verify, PING, defer /clank + "Clank It" + /credits, async-invoke the processor |
| `DiscordProcessor` | `src/handlers/discord/processor.processDiscord` | 300s | Async (Discord): per-guild mind → think → generate → edit deferred reply. IAM for prod stores ONLY (no `clank-mind-dev`). No sharp layer (no t-shirts). |
| `ImessageApi` | `src/handlers/imessage/api.handleImessage` | 300s | **Function URL** (sync long calls): `/auth` (Apple JWKS verify → session JWT; env-gated dev branch), `/generate` (per-chat `forTenant` mind → pipeline → signed DRAFT token, writes nothing), `/commit` (verify draft → remember+reflect). Two-phase per spec Gap 2: refusals/errors + never-INSERTED drafts don't enter memory. Commit fires client-side at INSERT (deterministic, our button) — NOT on Apple's send callbacks (a closed pane never receives didStartSending; the operator's call 2026-08-08). Insert also auto-dismisses the pane. Draft TTL 24h to cover the retry-on-next-activation path. Metering seams present, not engaged until StoreKit. Prod-only IAM; bills the Discord OpenRouter key. |

### Request Flow — Slash Command (`/clank`)
1. User types `/clank draw a robot in space` → Slack POSTs to `slackImageCommand`
2. Handler checks channel membership via `ensureBotInChannel()` (auto-joins public, gates private)
3. Acknowledges immediately ("Generating...", Slack 3s timeout), invokes `imageProcessor` async
4. **Think** (Sonnet, tool-calling loop): sees context (identity, journal, people, recent 50 prompts). **Recalls lore on demand** via `getEntityLore`/`getSemanticLore` tools (vector search over history), then decides IMAGE or TEXT and returns `{type, thoughts, imagePrompt}` (or `response` for text)
5. **Generate** (Mini): receives ONLY the `imagePrompt` — no context, no names. Returns image
6. **Save**: prompt, thoughts, imagePrompt, imageUrl, cost → DynamoDB (and history dual-written to S3 Vectors)
7. **Deliver**: posts **directly to the channel** via `chat.postMessage` (no preview/Send-Cancel gate — removed once config + retries were gone). Content (image/text) is public; refusals and technical errors are generic and stay ephemeral to the requester.

### Request Flow — Message Shortcut ("Ask Clank")
1. User clicks `⋮` on a message with an image → "Ask Clank"
2. `slackInteraction` receives `type: message_action`, checks membership, extracts image (files, attachments, or Block Kit image blocks)
3. Opens modal with reference image link + prompt input (original message text + author as context)
4. Submit → `view_submission` (callback_id on `payload.view`, NOT `payload`) → invokes `imageProcessor` with reference image + `threadTs`
5. Same think → generate flow, reference image passed to both think (Sonnet vision) and generate (Mini)
6. Delivered **directly** as a broadcast reply — `chat.postMessage` to the thread with `reply_broadcast: true` (shows in the thread AND the channel). No preview gate; the old thread-only + "also send to channel" checkbox is gone (nobody wanted thread-only).

**Text-only responses**: think returns `type: "text"` → generation skipped, Sonnet's `response` posted directly to the channel.
**Refusal / failure handling**: refusals and no-image outcomes return a generic error (via `adapter.error`), never Clank's voice. The real reason is recorded to memory + logs only. (`reactToFailure` removed 2026-08 for consistency across Slack + Discord.)
**Slash commands don't work in threads** — Slack platform restriction. The message shortcut is the thread-aware alternative.

### Request Flow — 🤖 Reaction Trigger ("summon Clank onto a message")
React 🤖 (`robot_face`/`robot`) to ANY message → Clank responds to that message. The reacted message IS the prompt — no typed instruction. Handler: `events.ts` → `imageProcessor` (`reactPrompt: true`) → `lib/platform/slack/flows/reactPrompt.ts`.
1. **Fires on the FIRST 🤖** (instant, no vote threshold) — unlike 👕 (needs 4).
2. **Exactly once per message, forever** — a conditional-write claim lock (`META / REACTED#<channel>#<ts>`, `attribute_not_exists`, no TTL) absorbs every later 🤖: second reactor, remove+re-add, all no-op. Claimed only AFTER a content check so an empty message doesn't burn the lock.
3. **Skips Clank's own messages** (no self-loops) — via `auth.test` identity (`getBotIdentity`, memoized) with an S3-image-domain fallback.
4. **Robust content extraction** (`messageContent.ts`, shared with Ask Clank): `extractImage` (files/attachments/blocks → reference image) + `describeMessage` (text + unfurled-link *content* + file notes + block-only text, capped 2000 chars).
5. **Surrounding-conversation window** (`fetchMessageContext` + `describeConversation`): pulls the neighbourhood so Clank gets the *premise* when the group is riffing back-and-forth — thread → parent + windowed replies (free; already in the `conversations.replies` payload), top-level → `conversations.history` both directions (`latest=` older + `oldest=` newer), merged/time-sorted. `describeConversation` renders a compact transcript (bot/Clank neighbours dropped, per-msg ~350 / total ~3200 char caps, `<@UID>` labels resolved in the same `resolveMentions` pass). **Anti-dilution is the whole point** (the operator): the reacted message is marked `⟵ THE REACTED MESSAGE` and the `summon` framing says respond to THAT one, using the rest as context only — never blend the thread. Empty transcript (lone/all-filtered) → falls back to single-message framing. Tune the window at `fetchMessageContext({before,after})` + `describeConversation` caps.
6. **Think knows the social triangle** (`summon` arg: `{author, summoner, self, conversation}`): WHO summoned + WHOSE message + self-vs-other + the transcript. First-person in the reacted message resolves to the AUTHOR, never the summoner (so an author's "draw me" renders the author). Ephemeral-only, never persisted → troll-safe.
7. **Delivery: ROOT channel, never threaded** (deliberate — the operator). A `chat.getPermalink` link back to the source rides in the credit line so the response keeps its anchor. Private "🎨 On it" notice → ephemeral to the summoner (anchored where they reacted). Image/text supported, no Send/Cancel gate.
**Scopes**: reads via `conversations.history`/`replies` need `channels:history` (public, already granted — 👕 uses it) / `groups:history` (private). No new event subscription (`reaction_added` already on). No IAM/infra change (same table + `updateItem`).

## Multi-Tenancy (the MindStore seam)
The memory **logic** (context build, remember, reflect) is platform- and tenant-neutral; only **data access** differs. That difference lives behind `MindStore` (`lib/memory/store.ts`), so one brain serves every community. **Callers pass logical attributes; each store owns its physical keys** — the memory logic never touches a key, so it can't leak or forget a tenant.
- **`LegacyStore`** (`legacyStore.ts`) — the current hand-rolled `db.ts` on `clank-mind-dev`, **UNTENANTED**. The live Slack Clank, byte-identical. Bound by default: `memory.buildContext/remember/maybeReflect/scanUserProfiles` ARE the legacy mind, so Slack callers are unchanged.
- **`ElectroStore`** (`electroStore.ts`) — ElectroDB (`entities.ts`) on `clank-mind-prod`, tenant-scoped. `memory.forTenant({tenant})` returns a prod-table `Mind` (+ its prod `VectorScope`). Discord uses this.
- **Tenant id** = `<platform>:<id>` (`tenant.ts`: `tenantId`, `scopeKey`, `tenantFilter`). Keys get a `TENANT#<id>#` prefix matching `scopeKey`; a per-tenant `byTime` gsi1 partition + a `byTenant` gsi1 partition (roster = one Query, not a table scan). Untenanted (`null`) → keys unchanged (Slack).
- **Vector isolation** at the `vectors.ts` boundary: `putVectors` stamps `metadata.tenant`, `queryVectors` AND-s the tenant into the filter. A `VectorScope {bucket,index,tenant}` threads mind→`remember`→`vectorSync` (write) and `mind.vectorScope`→`runArtPipeline`→`think`→`loreTools` (read). Default `LEGACY_SCOPE` (dev bucket, `tenant:null`) → Slack unchanged.
- **Why ElectroDB is prod-ONLY**: legacy rows lack ElectroDB's `__edb_e__` stamp, so its queries silently exclude them. Prod rows are all ElectroDB-native, so it's a non-issue there. Slack keeps `db.ts` until it migrates (dual-write → backfill ElectroDB-native → shadow → cutover; not yet done).
- **Isolation is defense-in-depth**: the DiscordProcessor has IAM for the prod stores ONLY — it literally cannot touch `clank-mind-dev`, not just by code.

## Discord (HTTP interactions — no gateway/persistent bot)
Serverless, same shape as Slack (ack-then-async). Adapter in `lib/platform/discord/` (`verify` Ed25519, `client` @discordjs/rest, `message` reader). `handlers/discord/interactions.ts` verifies + routes; `handlers/discord/processor.ts` runs the shared core against the guild's `forTenant` mind.
- **`/clank <prompt>`** — CHAT_INPUT slash command. **"Clank It"** — MESSAGE context-menu command (right-click → Apps): the target message IS the prompt (text + first image attachment + author + inlined reply-parent if present), reuses `downloadReferenceImage` (Discord CDN is public → `isPublic` fetch) + the same **summon framing** as Slack's 🤖.
- **Each GUILD is a tenant** (`tenantId('discord', guildId)`) — a blank-slate Clank per server. Reactions (🤖) are NOT possible here (they need a persistent gateway worker); the message menu is the HTTP-interactions equivalent.
- **Commands are GUILD-ONLY** (`integration_types:[0]`, `contexts:[0]`) — no user-install "use everywhere", keeping tenancy = one mind per server. Register all three (`/clank`, "Clank It", `/credits`) via `scripts/register-discord-command.ts` (needs `DISCORD_*` in `.env`; global commands take ~1h to first appear).
- **Delivery**: edit the deferred reply via the interaction token (`auth:false`, no bot token). Images upload as a FILE whose attachment `description` is Clank's thoughts — Discord's alt-text channel (the "ALT" badge), the same hidden signature Slack carries in `alt_text`. Falls back to embedding the S3 URL if the fetch fails.
- **Appearance policy**: Discord tenants run **pure emergence** — nothing populates `appearance`/`aliases` (they were always manual scripts against the Slack table), so `buildContext` renders no "WHAT THEY LOOK LIKE" line and Clank interprets people like emergent characters (Pissatron/Carl). Slack keeps its frozen curated profiles. This split is FREE (separate stores) and deliberate — curation protects fidelity to real people you *know*; strangers have no ground truth to protect. See Known Decisions.

## Models

### Model Roles (`MODEL_ROLES` in `lib/models.ts`)
| Role | Model | Purpose |
|------|-------|---------|
| `text` | `anthropic/claude-sonnet-5` | Think step: recall lore via tools, decide image/text, craft imagePrompt + thoughts |
| `image` | `google/gemini-3.1-flash-lite-image` (Nano Banana 2 Lite) | Image generation from the imagePrompt (no context). **Trial** (2026-07, was `openai/gpt-5-image-mini`): cheapest+fastest in the bake-off (~$0.034/img, ~3s vs mini's ~$0.047/54-74s), no refusals, and `in:[image,text]` so reference-image editing (Ask Clank + 🤖-reaction) works — smoke-tested. Revert to `google/gemini-2.5-flash-image` or `openai/gpt-5-image-mini` if the line loses character. |
| `reflection` | `anthropic/claude-sonnet-5` | Periodic identity + journal rewrite (every 50 interactions) |

### Pipeline: Think (with tools) → Generate
1. **Think** (`think.ts`, Sonnet): a **tool-calling loop**. Clank recalls lore with `getEntityLore`/`getSemanticLore` (over the vector store), then returns `{type, thoughts, imagePrompt}`. The system+context prefix uses **prompt caching** (`cache_control`) so the tool-loop turns re-read it ~90% cheaper. ~$0.02-0.07/request. The answer is delivered via the **`submitResponse` tool** (constrained decoding, forced on the final turn of an 8-turn budget) — there is no JSON-in-prose to parse or repair.
2. **Generate** (`generate.ts`, Mini): receives ONLY the `imagePrompt`. No context, no lore, no names. Mini is the hand, not the brain.

**Clank owns the art** — he doesn't know about the think/generate split. Failures are his, not "the image model's." The imagePrompt is HIS interpretation, not a neutral transcription (see ARTISTIC VOICE in the think prompt).

## Memory System

### What Clank sees per request (context)
1. **System prompt** — personality, artistic voice, JSON format, appearance/lore rules, tool instructions
2. **Core identity** — self-portrait (~10-14 distinct ideas), evolved every 50 interactions by reflection (carried forward, not rewritten from scratch — durable core persists/deepens, stale drops)
3. **Era chapters** — `EARLIER CHAPTERS`: up to 3 one-paragraph autobiography condensations (one written every 10th reflection over the last 10 journal entries; stored on `META|IDENTITY.eraSummaries`) so medium-term self-history survives the small journal window
4. **3 journal entries** — append-only diary (recent window)
5. **People roster** — 15 users: aliases, appearance, request count
6. **Recent 50 history prompts** — recency for thread continuity ("continue" handling)
7. **Recalled lore** — NOT pre-injected. Clank pulls relevant lore on demand via tools.
8. **Commitments** — `YOUR COMMITMENTS`: actionable resolutions from reflection he's told to honor when a request touches one — and to consult AT the flag (refusal reflex / skim suspicion), before deciding, not after (fix-at-the-flag, 2026-08-08)

### Lore = vector memory, recalled via tools
- **The store**: S3 Vectors index `clank-memory`, holding `type=history` (every user prompt) + `type=lore_description` (41 canonical definitions, re-vectorized from META|LORE), embedded via OpenRouter `text-embedding-3-small`). `lib/vectors.ts` (put/query), `lib/embeddings.ts` (embed).
- **The tools** (`lib/loreTools.ts`): `getEntityLore(name)` recalls the canonical **description** (`type=lore_description` — the definition; crucial for *concepts/modes/doctrines* like cerebro mode or consent doctrine that history only *invokes*, never *defines*) PLUS history **usage**. `getSemanticLore(query)` searches `type=history` for topical past moments. Both return raw text. The think step calls them; Clank identifies entities + relationships **by reading** (no character list to maintain), including multi-hop (a recalled prompt mentioning "X's friend Y" → recall Y).
- **Dual-write**: `remember()` mirrors every new history entry to the vector store (`lib/vectorSync.ts`, `syncHistoryEntry`). Kill switch: `VECTOR_DUAL_WRITE=false`.
- **Lore is user-authored**: tools return raw user prompts. Clank decides what to recall; he never invents canon, and imagePrompts (his own output) are NOT used as lore.

### What gets stored per interaction (DynamoDB `HIST#<uuid>`)
`prompt`, `response` (thoughts), `imagePrompt`, `imageUrl`, `referenceUrl`, `cost`, `outcome` (success/text_only/refused/error), `source` (slash/shortcut/reaction), `errorMessage`, `handle`, `userId`, `timestamp`, `historyId`. Plus: history dual-written to S3 Vectors; `requestCount`/`lastSeen` updated on the user profile. (`disposition` retired with the Send/Cancel preview.)

### What updates every 50 interactions (Reflection)
`introspection.ts` — reads current identity + 5 journal entries + **200 history entries WITH thoughts AND outcome flags** (`[YOU REFUSED THIS]` / `[you answered in text]` — Reflexion's lesson: self-critique needs objective feedback. Technical errors are deliberately NOT flagged: they're ours, not his — no commitment can act on them, and surfacing infra noise into identity work is rumination fuel), evolves `coreIdentity` (~10-14 distinct ideas, carried forward from the prior identity — durable core persists/deepens, only stale drops) and appends a `selfReflection` journal entry (8-15 sentences). Each journal entry also snapshots the `coreIdentity` produced that cycle (`coreIdentitySnapshot`) so identity evolution has a trail (the `META|IDENTITY` item itself is overwritten). Output is identity + journal + **commitments** — no lore or user-profile data. Reflection NEVER reads or writes lore/facts/profiles. Cooldown 2 min; conditional-write lock on `lastReflectedAt` prevents concurrent duplicates.
- **Stuck-record guard** (2026-08-08): the fresh journal draft is embedded and compared to the last 3 entries; max cosine similarity > **0.90** (empirical p95 of real entries = 0.895, historical max 0.901) → ONE nudged rewrite ("that's rumination — what's actually new?"), never loops, any failure keeps the original. This is the dynamic generalization of the static vocabulary ban.
- **Commitment audit** (2026-08-08): carrying a commitment forward requires citing a concrete moment from the history window where it changed behavior; can't cite → sharpen (smaller move, more specific trigger) or drop. Never recopy an unacted-on commitment.
- **Era consolidation** (2026-08-08): every **10th** reflection (`ERA_EVERY`), one extra call condenses the last 10 journal entries into a one-paragraph "chapter" (≤900 chars — advisory to the model, ENFORCED by one condense-retry keeping the shorter draft; dry-run 2026-08-08 showed raw drafts ~30% over); last **3** (`ERA_KEEP`) live on `META|IDENTITY.eraSummaries` (an ElectroDB-declared list attribute — prod schema updated + round-trip verified) and render as `EARLIER CHAPTERS` in context. Threaded through every `putIdentity` (full-item replace would otherwise wipe them, same as commitments). Failures never break the reflection. 3 chapters were backfilled 2026-08-08 from real journal history (windows aligned to the reflection counter; they pre-date the length ceiling and age out naturally by ~#250).

### ACTIVE EXPERIMENT — reflection upgrades (shipped 2026-08-08; VALIDATE around reflection #232, ~late Aug 2026)
The 4 mechanisms above (outcome flags, commitment audit, stuck-record guard, era chapters) + fix-at-the-flag in the think prompt are an instrumented experiment. **Pre-change baselines, measured 2026-08-08:**
- Identity drift: per-cycle embedding distance mean **0.055** (flat across 43 snapshots, no trend); oldest→newest **0.202** (= 86% of max pairwise gap → anchored drift, ratio-to-random-walk 0.30). Method: embed each journal row's `coreIdentitySnapshot` (`text-embedding-3-small` via OpenRouter), cosine distance, consecutive + vs-first.
- Journal similarity (drives the guard): consecutive-window max-sim p50 **0.862** / p95 **0.895** / max **0.901** over last 40 entries → threshold 0.90 ≈ fires 1-in-20 cycles.
- Commitments: 10 cycles snapshotted, **0 verbatim recopies**, churn 0.071/cycle (> identity's 0.055); "wrong strong read" commitment GRADUATED into coreIdentity after 5 cycles (genealogy `CCCCC→IIIII`) — graduation is organic, deliberately NOT prompted.
- Known-stuck failure: identity names 4 reading-speed failures ("not fixed by naming it") — the ledger that fix-at-the-flag targets.
- Sincerity-principle invocation in per-request thoughts: 0.9% (Mar) → 20.3% (Aug) — the reference case of a principle that DID reach behavior.

**Validation checklist (any session can run this cold):**
1. Per-cycle drift still ≈0.055. If it **drops**, the guard is suppressing growth, not rumination → loosen threshold above 0.90.
2. Reading-speed ledger stopped growing (no new named instances in recent `coreIdentitySnapshot`s); near-refusal thoughts show the test running BEFORE the decision.
3. Refusal commitment under Gemini (few refusals to act on): sharpened/graduated/dropped via the audit — never recopied verbatim.
4. `Stuck-record guard:` log lines fire ≈1-in-20; read the first draft-vs-rewrite pair (the real quality eval); journal p-max should sit <0.90 on re-measure.
5. Era #230 wrote (`Era summary written` log), ≤900 chars, and thoughts/journal reference events older than the 3-entry journal window (the chapters working as memory).
Delete this section once validated; record durable findings above it.

### Commitments (evolving, on `META|IDENTITY`)
Reflection writes 1-4 CONCRETE actionable commitments — scoped to (a) himself/self-understanding and (b) real relationships. **Banned: vague platitudes AND any lore/story commitments** (lore is user fiction, not his personality). Persist on IDENTITY (not the aging journal window), evolve each cycle (carry live / drop stale). Surfaced to think as `YOUR COMMITMENTS`; honored when a request touches one — but he must NEVER cite one by number ("Commitment #3") in thoughts (thoughts leak to image alt-text). Loop verified: written → acted-on → evolved.

### Frozen — manual only (anti-troll)
- **Appearance** (max 6) + **aliases** per user. Reflection was corrupting them via misattribution and troll absorption. A real person's APPEARANCE is authoritative from their PROFILE — recalled lore never changes a face, so one user can't alter another's via a prompt. Permanent appearance changes = manual profile edit (e.g. via a photo).

### Single-Table Design (Key Patterns)
```
pk          | sk              | Purpose
────────────┼─────────────────┼────────────────────────────────
META        | IDENTITY        | coreIdentity, commitments, eraSummaries, reflectionCount, lastReflectedAt
META        | REFLECTION#<ts> | Journal entry (field: text)
META        | LORE            | Legacy facts/descriptions (UNUSED — kept, not read)
META        | REACTED#<ch>#<ts> | 🤖-reaction claim-once lock (conditional write; permanent)
USER#<uid>  | PROFILE         | handle, aliases, appearance, requestCount
HIST#<uuid> | ENTRY           | History entry
META        | SHIRT_LOG       | 👕 t-shirt dedup log (Slack)
GUILD#<gid> | METER           | Per-server shared FREE pool (cost ceiling; paid renders skip it)
METER#<uid> | METER           | GLOBAL Discord wallet: credits, free-daily, cooldown,
            |                 | grantedEnts/clawedEnts. PROD table, NOT tenant-prefixed.
```
**GSI `gsi1`**: `gsi1pk=HIST`, `gsi1sk=timestamp` — time-ordered history (recency window + reflection input).

### scanUserProfiles MUST paginate
DynamoDB scan returns max 1MB before filtering. With 15+ profiles among thousands of items, a single scan misses users. `scanUserProfiles()` paginates with `ExclusiveStartKey`. Critical bug if not — users go invisible and Clank draws the wrong person.

## File Structure
Rule: **root = project config, `src/` = code, `src/handlers/<platform>/` = the deploy
surface (the only things sst.config.ts calls). `lib/imageProcessor/` is the shared
platform-neutral core; platform-specific product flows live under `lib/platform/<p>/`.**
```
src/
  handlers/             Deploy surface, one dir per PLATFORM (the only things sst.config.ts calls)
    slack/
      slashCommand.ts   /clank entry — parses, invokes processor async
      interactions.ts   Ask Clank / Make T-Shirt shortcuts + Ask Clank modal (no buttons)
      events.ts         Events API — 👕 reactions → t-shirt; 🤖 → summon
      processor.ts      Slack async worker/orchestrator (was lib/imageProcessor/index.ts): context → pipeline → Slack DeliveryAdapter → consumeOutcome
    discord/
      interactions.ts   Discord HTTP endpoint — verify, PING, route /clank + "Clank It" + /credits → defer + async-invoke
      webhook.ts        Discord webhook events — ENTITLEMENT_CREATE (grant) / ENTITLEMENT_DELETE (refund clawback)
      processor.ts      Discord async worker — per-guild forTenant mind → reconcileCredits (List Entitlements API) → pipeline → consumeOutcome → edit deferred reply; also handles /credits (balance + buy buttons)
    imessage/
      api.ts            Function-URL Lambda (NOT API GW — 29s cap vs sync 30-120s generates): POST /auth /generate /commit
  prompts/
    think.ts            THINK_PROMPT + RESPONSE_TOOL — Clank's personality, a first-class editable artifact
  lib/
    memory/
      index.ts          Barrel: default (Slack/legacy) mind bound + `forTenant()`; exports `legacyMind`, `Mind`
      store.ts          `MindStore` (memory data-access seam) + `MeterStore` (the global wallet seam) + `UserMeter`
      legacyStore.ts    MindStore over db.ts (Slack, untenanted) — byte-identical to the old code
      electroStore.ts   MindStore over ElectroDB entities (prod, tenant-scoped)
      entities.ts       ElectroDB models (prod, tenant-composite keys) + bindTable + isConditionalFailure
      tenant.ts         scopeKey / scopePrefix / tenantFilter / tenantId (backward-compatible: null tenant = unchanged)
      metering.ts       MeteringPolicy: Unmetered (Slack) + Metered (Discord free-daily + cooldown + credits); talks to a MeterStore
      meterStore.ts     GLOBAL per-user wallet (credits/free/cooldown keyed by METER#<userId>, NOT per-tenant)
      constants.ts      REFLECT_EVERY (50), REFLECT_COOLDOWN_MS, TABLE_NAME
      db.ts             Raw DynamoDB helpers (used by LegacyStore + Slack-only reactPrompt/tshirt)
      persistence.ts    remember(store, scope, …) (+ tenant-scoped vector dual-write)
      introspection.ts  maybeReflect(store)/reflect(store, …) (identity + journal only; snapshots identity per entry)
      context.ts        buildContext(store, …) (identity, journal, people, recent 50); resolveMentions/buildAliasTokens (pure); formatTimeAgo
    imageProcessor/     THE SHARED CORE — platform-neutral art flow ONLY (no platform imports)
      think.ts          Clank's brain: tool-calling lore recall, structured output via submitResponse, prompt caching
      generate.ts       Mini hand: image from imagePrompt (no context) + deadline-aware genTimeoutMs
      summon.ts         REACTED_MARKER — cross-platform summon-framing anchor (think + Slack 🤖 + Discord "Clank It")
      upload.ts         S3 upload + detectImageMime (magic-byte sniff)
      parse.ts          Response parsing + error classification (ParseResult type)
      pipeline.ts       runArtPipeline (think → generate → classify → ArtOutcome) + downloadReferenceImage
      consume.ts        consumeOutcome + DeliveryAdapter — the shared delivery back-half (remember/reflect/classify)
    platform/
      slack.ts / slack/ Slack adapter (WebClient, Block Kit, request verify)
        flows/          Slack-ONLY product flows (were mixed into imageProcessor/):
          reactPrompt.ts    🤖-reaction trigger: reacted message → respond (root channel, once-per-message lock)
          tshirt.ts         Merch subsystem: processTshirt + processTshirtReaction
          messageContent.ts Pure Slack-message readers: extractImage + describeMessage (shared with Ask Clank)
          productName.ts    Pure t-shirt naming (derive/clean/validate)
      discord/          Discord adapter: verify (Ed25519), client (@discordjs/rest incl. entitlements), message (reader)
    openrouter.ts       Shared OpenRouter HTTP client (chat/embed/credits)
    loreTools.ts        getEntityLore / getSemanticLore — tool defs + tenant-scoped vector search
    embeddings.ts       OpenRouter text-embedding-3-small wrapper
    vectors.ts          S3 Vectors put/query + VectorScope/LEGACY_SCOPE (tenant stamp on write, filter on read)
    vectorSync.ts       Dual-write history → vector store (scope-aware)
    format.ts           fmtCost / trunc / elapsed (platform-neutral shared idioms)
    lambda.ts           invokeAsync (one LambdaClient, shared by handlers)
    models.ts           MODEL_ROLES, model registry
    printify.ts         Printify t-shirt + sticker creation
    funding.ts          OpenRouter balance check + funding-anxiety context line
    credits.ts          Discord credit packs: SKU->credits map + premium buy-button rows (style 6)
test/                   node:test unit tests (run via tsx) for the pure surface
scripts/                Recurring ops tools (report, register-discord-command); own DynamoDB clients, do NOT import src/lib
site/                   <your-site> static site (landing + terms + privacy), deployed via the SST `site` stage
ops/email-forwarder/    contact@<your-site> -> Gmail forwarder Lambda (standalone; SES receipt rule; deployed manually, not via SST)
sst.config.ts           SST infra: Lambda functions, REST API, S3 images bucket, custom domain, the `site` static-site stage; external DynamoDB + S3 Vectors refs + IAM
biome.json tsconfig.json  Lint/format (Biome) + type-check (TypeScript, ESM)
AGENTS.md CLAUDE.md     Agent instructions (vendor-neutral / Claude-specific)
```

## Dev workflow
`npm run check` (lint + typecheck + test) must be green. Pieces: `npm run lint`
(Biome), `npm run typecheck` (`tsc --noEmit` — SST/esbuild does the real build),
`npm test` (`node:test` via tsx). Auto-fix: `npm run lint:fix`. See [AGENTS.md](./AGENTS.md).

## Deployment & Local Testing
Git remote: `origin` → `github.com/the operatoryDunn/clank.git`. Deploy with `npm run deploy:dev` (runs `sst deploy --stage dev`). Local live dev: `npm run dev` (`sst dev`).
- Local scripts: `AWS_PROFILE=<your-profile> DYNAMODB_TABLE_NAME=clank-mind-dev node --env-file=.env scripts/x.ts` — `source .env` sets shell vars but doesn't export them to node children (→ null table / 401); `--env-file` does. Descending GSI via AWS CLI needs `--no-scan-index-forward`.
- One-off `.mjs`/node scripts that `import` project deps (`@aws-sdk/*`, etc.) MUST run from inside the repo — ESM resolves `node_modules` from the script's own directory upward, and `NODE_PATH` is ignored (scratchpad scripts fail `ERR_MODULE_NOT_FOUND`). Put throwaway scripts in a repo subdir; scripts using only `node:` builtins + global `fetch` can live anywhere.
- Adding new DynamoDB/s3vectors ops requires updating IAM in `sst.config.ts` — fails silently in Lambda otherwise
- Test the think step locally: build a context via `memory.buildContext()`, call `think(prompt, context)`
- Replay a missed reaction manually: `aws lambda invoke --function-name <processor> --payload '{"tshirtReaction":true,"channelId":"...","messageTs":"..."}'` (or `"reactPrompt":true`) — safe to re-run; SHIRT_LOG / REACTED# locks absorb duplicates.

```bash
cd /Users/user/dev/clank
npm run deploy:dev                                # deploy bot (sst deploy --stage dev) — outputs discordEndpoint too
npm run deploy:site                               # deploy the <your-site> static site (isolated `site` stage; SITE_PREVIEW=1 skips the domain)
npx sst logs --stage dev                          # logs (watch [Think] recalls=...)
node --env-file=.env --import tsx scripts/register-discord-command.ts   # (re)register /clank + "Clank It" + /credits (guild-only)
AWS_PROFILE=<your-profile> node --import tsx scripts/report.ts   # mind snapshot — SLACK ONLY (clank-mind-dev; no tenant support yet)
# Discord mind spot-check (no report tool yet): scan clank-mind-prod for TENANT#discord:<guildId>#…
source .env && curl -s "https://openrouter.ai/api/v1/credits" -H "Authorization: Bearer $OPENROUTER_API_KEY"   # balance
```
Discord Lambda log group **hash rotates on every deploy** — re-find with `aws logs describe-log-groups --log-group-name-prefix /aws/lambda/clank-dev-DiscordProcessor`.

## Code Style
- TypeScript + ESM (relative imports keep `.js` specifiers), no separate build step (SST/esbuild builds at deploy), 4-space indent
- All DynamoDB/API calls awaited; try/catch with `console.error`, never crash the Lambda
- Independent DynamoDB reads use `Promise.all`
- Scripts in `scripts/` use their own DynamoDB clients — they do NOT import from `lib/memory`

## Known Decisions (Do Not Revert)
- **Stateful stays external (by design)** — SST manages the compute (Lambdas, API, domain, images bucket); the DynamoDB table + S3 Vectors bucket are referenced by name + IAM, never owned by SST. Decouples the data lifecycle from deploys (no deploy/remove can touch Clank's mind), and S3 Vectors is too new for IaC providers to manage anyway. Flip to SST-owned only if we ever need multiple from-scratch environments (careful Pulumi import + `protect`)
- **Multi-tenant via a MindStore seam** — memory logic is tenant-neutral; `LegacyStore` (Slack, `db.ts`, untenanted, bound by default) and `ElectroStore` (prod, ElectroDB, tenant-scoped) COEXIST. ElectroDB is prod-ONLY (legacy rows lack its `__edb_e__` stamp). Callers pass logical attributes; stores own physical keys. Slack stays byte-identical until its own migration
- **Appearance: pure emergence public / frozen curated Slack** — curation protects fidelity to real people you KNOW (ground truth); public strangers have no ground truth to protect, so a self/troll description can't be "wrong". Discord tenants never populate `appearance`/`aliases` → Clank interprets like emergent characters. DON'T build AI auto-curation of lore/faces — that's what corrupted Slack profiles and it breaks "Clank never invents canon". The scalable answer is emergence + (optional) self-service, never automated editing
- **Discord = HTTP interactions, not a gateway bot** — serverless. `/clank` + "Clank It" MESSAGE context-menu (the summon-a-message equivalent). Emoji reactions (🤖) are impossible without an always-on gateway worker — deliberately deferred. Commands are guild-only (`integration_types:[0]`) so tenancy stays one-mind-per-server. Delivery edits the deferred reply via the interaction token (no bot token); thoughts ride in the image's attachment `description` (the alt-text easter egg)
- **consumeOutcome is the shared delivery back-half** — `runArtPipeline` → `ArtOutcome`, then `consumeOutcome(pipe, ctx, adapter)` owns remember/reflect/classify; each caller (Slack /clank, 🤖, Discord) supplies a 3-method `DeliveryAdapter`. `ctx.mind` selects the tenant mind (defaults to legacy → Slack unchanged)
- **Personality is NOT hardcoded** — Clank evolves through interactions + reflection
- **Clank owns his art** — no awareness of the think/generate split; failures are his. The imagePrompt is his interpretation (ARTISTIC VOICE), not a neutral transcription — personality must reach the IMAGE, since users never see his thoughts
- **Lore via tools, not context dump** — Clank recalls relevant lore on demand (`getEntityLore`/`getSemanticLore`) over the vector store, one coherent mind. Facts layer + frozen descriptions are RETIRED. Lore is user-authored (raw prompts), never Clank's own imagePrompts
- **Recall by relevance, not recency** — the vector store surfaces relevant lore from any point in time; the 50-prompt recency window is only for thread continuity ("continue")
- **Prompt caching** on the think step's static prefix — makes the tool loop affordable (~90% cheaper cached reads)
- **Frozen user data** — appearance/aliases manual-only. A user's face comes from their PROFILE, authoritative; recalled lore never changes it (troll-safe)
- **Minimal reflection** — `coreIdentity` + `selfReflection` + `commitments` (self + real-relationships, no lore/platitudes). Never touches lore/facts/profiles. Reflect every 50; sees 200 prompts WITH thoughts
- **Vocabulary ban** in reflections — "servos", "sitting with", "background processes", etc.; no rumination on drawing failures
- **No preview gate, no Regenerate button, no model selector, no router** — Clank decides image/text organically and posts **directly to the channel** (Send/Cancel preview + `disposition` removed 2026-08 once config/retries were gone — bare Send/Cancel was pure ceremony, and the 🤖 flow already proved direct-post). Content (image/text) is public; refusals and technical errors are generic and stay ephemeral to the requester.
- **Video REMOVED (2026-08)** — the LTX/fal output type + the video-resentment personality arc were cut because the clips were consistently poor. `generateVideo.ts` deleted; `type:"video"`, the `motion` field, the `'video'` ArtOutcome kind, and the "HOW YOU FEEL ABOUT VIDEO" prompt sections are all gone. Don't re-add without a materially better model. (Old stored journal/identity entries may still reference video-resentment; they age out via reflection.)
- **Metering = a per-tenant POLICY on the Mind, not a platform branch** (`metering.ts`). Slack's `legacyMind` runs `UnmeteredPolicy` (reserve always ok, charge no-op, so Slack is unaffected BY CONSTRUCTION). Discord runs `MeteredPolicy`: a free daily cap + cooldown, then a paid credit balance. Two shared seams: `mind.reserve(userId)` gates BEFORE the pipeline (Discord processor; Slack unmetered so needs none), `mind.charge(userId)` on image-success inside `consumeOutcome`. Only images cost (text/refusals free). **The free tier is a ONE-TIME TRIAL, not a daily allowance** (`DISCORD_TRIAL_CREDITS`=1). Freemium assumes near-zero marginal cost; ours is real (~$0.10/render) and it GROWS as a tenant accumulates memory — a new server costs ~$0.057/render, a mature one like Slack ~$0.099, because the think step is ~55% of cost and scales with context. So a daily allowance is an unbounded per-user liability (~$3/user/mo forever) while a trial is a fixed ~$0.10 acquisition cost that can never repeat. Granted via `grantOnce(trial:<userId>)`, reusing the entitlement idempotency ledger. The daily + per-server dials (`DISCORD_FREE_PER_DAY`, `DISCORD_SERVER_FREE_PER_DAY`, server pool at `GUILD#<id>`) still exist and are tested, but default to **0** — flip them on if a recurring tier returns. With cost bounded per account, the per-server ceiling is unnecessary. **Packs use a SHALLOW volume discount** (8/$2.99, 20/$6.99, 40/$12.99 = $0.374 → $0.325/credit): steep discounts assume marginal cost ~0, and with real per-render cost the biggest pack would otherwise be the worst-margin product. All knobs env-overridable
- **The wallet is a GLOBAL per-user ledger, NOT per guild** (`meterStore.ts`, key `METER#<userId>` on the prod table, un-tenant-prefixed). Credits + free-daily + cooldown are ONE balance per Discord user across every server, because Discord purchases (entitlements) are user-owned and follow the user. Memory stays per-guild (the tenancy point); only the economy is global. `MeteredPolicy` talks to a `MeterStore` seam, so this is decoupled from the tenant `MindStore`
- **Paid credits are LIVE** (`credits.ts`) — 3 consumable SKUs (12/35/90 credits; IDs in `credits.ts`), sold via `/credits` (balance + premium buy-buttons, style 6) and on the out-of-credits `/clank` denial.
- **The wallet is ATOMIC, never read-modify-write** (`meterStore.ts`). Every op is one CONDITIONAL DynamoDB update: `claimCooldown` (the serialiser — exactly one of a user's concurrent requests wins, which is what keeps the allowance checks honest), `consumeFree` (capped), `spendCredit` (can't go negative), `grantOnce`, `clawback`. Unconditional SETs previously let a user fire in N servers at once to bypass the cooldown AND the free cap, or buy N images with 1 credit. Unit tests mock DynamoDB — **verify set semantics (`contains`/ADD) against the real table** before trusting a change here
- **Grants are idempotent per entitlement id** — `grantOnce` writes the id into `grantedEnts` in the SAME conditional update as the balance bump, so a failed consume, a Lambda retry, or a concurrent reconcile can never double-credit. This is also what makes clawback possible
- **Chargebacks are recoverable, not invisible** (`handlers/discord/webhook.ts`, `POST /discord/webhook`) — Discord is the reseller and **deducts refunds + chargebacks from our payout**, so a buy → spend → chargeback used to cost us the reversal AND the generation, silently. `ENTITLEMENT_DELETE` now claws back the UNSPENT remainder (spent credits are gone — we ate those renders); `ENTITLEMENT_CREATE` grants instantly. Ed25519-verified, must answer **204 within 3s**. Never 5xx at Discord — it retries and can disable the endpoint
- **Reconcile via the List Entitlements API, never the interaction payload** — the payload `entitlements` array is buggy/empty for HTTP apps (**discord-api-docs#7038**). `exclude_deleted` defaults true, so refunded entitlements are already filtered out. `reconcileCredits` runs on `/credits` and on the `/clank` out-of-credits path (grant, then re-gate before denying)
- **Charge and reflect AFTER delivery** (`consume.ts`) — charging first meant a failed post charged for an image nobody saw; reflecting first (a ~$0.14 LLM call every 50th interaction) made that unlucky user wait through it. Reflection failures are swallowed: they must never break a delivered response
- **Only a finished image or Clank's text reply is PUBLIC** on Discord — every error, refusal, and credit/limit denial is ephemeral to the invoker (`processor.ts` `ephemeral()` deletes the deferred placeholder, then posts a `flags:64` followup)
- **Funding anxiety is Slack-only** (`buildContext(..., includeFunding)`) — on a paid tenant it leaks machinery and is wrong anyway (Auto-Recharge keeps the Discord balance low by design, so every paying server's Clank would be permanently broke). Prompts are platform-neutral ("your community", never "Slack") since Discord tenants read them too
- **Async retries are OFF on both processors** — neither is idempotent, so a timeout re-ran generate + charge + post
- **Discord uses a SEPARATE OpenRouter account** (`DISCORD_OPENROUTER_API_KEY`, set 2026-08) — Discord is a monetized product, so its generation bills its own account (own credits + Auto-Recharge) while Slack stays on the personal account. Zero code change: the DiscordProcessor is a separate Lambda, so its `OPENROUTER_API_KEY` env points at the Discord key (falls back to the Slack key if unset). ALL Discord generation (think + image + embeddings + reflection) bills there
- **Commitments are narrative, not per-user state** — they live in Clank's own evolving self-doc (his interpretation, the operator as trust-filter), never writable user attributes → troll-safe. Scope: self-understanding + real relationships, NEVER lore
- **historyId** — UUID created at `remember()` time and used as the `HIST#<uuid>` key; returned to callers (was threaded through button payloads before the preview was removed)
- **scanUserProfiles must paginate** — 1MB scan limit drops users otherwise
- **Policy refusals are CHARGED; technical failures are not** (`isChargeableFailure` in `consume.ts`). If the prompt was rejected we did the work and the cause was the request; if our upstream timed out that's ours to eat. This also closed a real hole: `charge()` previously ran only on image success, so a user could send failing prompts indefinitely at one per cooldown, burning think cost (~$0.04 each) while never spending a credit. `isContentPolicyRefusal` was tightened first — it used to match a bare "sorry", so "Sorry, something went wrong" counted as a refusal, and charging on that false positive would take a credit for OUR outage. It now needs an explicit policy phrase or a refusal verb attached to a creation verb
- **Failures show a generic error, never Clank's voice.** Refusals and no-image outcomes go through `adapter.error` (a generic line, same as technical errors); the real reason is still recorded to memory + logs, so a failure is never a peek at Clank's inner workings. `reactToFailure` deleted; consistent across Slack + Discord (2026-08)
- **Text replies are a strong last resort.** The think prompt heavily biases IMAGE; text is reserved for a direct question about Clank that genuinely cannot be drawn (2026-08), both platforms
- **🤖 reaction = summon Clank onto a message** — fires on the FIRST 🤖 (instant, no threshold), responds EXACTLY ONCE per message forever (permanent conditional-write lock — survives second reactors + remove/re-add), posts to the ROOT channel (never threaded; permalink back to source), skips Clank's own messages. Think gets the social triangle (who summoned / whose message / self-vs-other) as ephemeral context — never persisted, so troll-safe; the message's first-person is the AUTHOR, not the summoner
- **Bot token for delivery** — `chat.postMessage` direct to channel (errors via `chat.postEphemeral`); **auto-join public channels**; **view_submission callback_id** at `payload.view.callback_id`

## Ops Runbook
Deployment-specific support runbooks (manual credit grants, the email forwarder, webhook registration) live in the gitignored `CLAUDE.local.md` for the operator of a given instance.

## Gotchas & Lessons Learned
- **Appearance swaps**: Sonnet may copy a physical description from a recalled/history prompt instead of the PEOPLE YOU KNOW roster. The think prompt forces lookup ("STOP AND VERIFY", "USE ALL BULLETS"). If someone looks wrong, check the imagePrompt — profile data may be right but ignored.
- **This group trolls each other**: any automated profile update gets abused ("<person> is morbidly obese"). Manual-only for appearance/aliases; lore (events) is auto but never changes a real face.
- **Self-description can be trolling too**: users troll in the first person (Ted's "bald/dark mustache" was a bit). the operator (with real-world knowledge of the people) is the trust filter for profiles, not self-vs-third-party.
- **Emergent characters** (Pissatron, Carl) have no curated description — appearance comes through the user prompts that established them (recalled via tools) and can drift; distinctive characters stay consistent, generic ones less so. Accepted tradeoff for zero-maintenance.
- **S3 Vectors is similarity-only** — no time-sort. "Oldest/newest" or superlative/temporal queries are a blind spot; DynamoDB's GSI handles recency.
- **Bedrock embeddings blocked**: account-level 0-RPM quota (non-adjustable) made Titan unusable; using OpenRouter embeddings instead. Anthropic has no embeddings API.
- **OpenRouter model IDs**: short form (`anthropic/claude-haiku-4.5`), not date-suffixed.
- **Vetting a model before a swap**: `curl -s https://openrouter.ai/api/v1/models` (public, no key) → `architecture.output_modalities:[image]` = it's a generator; `input_modalities:[image]` = it takes reference images; plus `pricing` + `supported_parameters`. True per-image cost = the generation response's `usage.cost`; the DynamoDB `cost` field is the TOTAL request (think + image), NOT image-only.
- **WebP magic bytes**: check bytes 0-1 (RIFF) AND 8-9 (WEBP) — 0-1 alone matches AVI/WAV.
- **Printify Pop-Up Store assigns `external.id` asynchronously after publish** (15-30s via background job). The poll budget in `createProductsFromImage` is intentionally 60s — don't shrink it. Use `external.handle` directly when present. Also: publish races mockup generation — the storefront can be born imageless; re-publish after mockups render (`lib/printify.ts`).
- **Lambda log group ≠ the name SST prints on deploy**, and it can rotate — deploy shows `...ProcessorFunction-<hashA>`, logs may be under `<hashB>`. Find the live one: `aws logs describe-log-groups --log-group-name-prefix /aws/lambda/clank-dev-Processor --profile "$AWS_PROFILE"`. `scripts/report.ts` (DynamoDB) is the authoritative activity source when logs are ambiguous.
- **🤖 reaction only fires for channels Clank is IN** — Slack delivers `reaction_added` events only for channels the bot is a member of. A reaction in a channel Clank isn't in produces NO event (silent). `/clank` + shortcuts still work there (Interactivity is separate from Event Subscriptions), so "reactions dead but slash works" = channel membership OR a disabled Event Subscription, NOT a code bug. Health-check the endpoint with a `url_verification` POST.
- **Match ANY robot emoji, not exact names** — `events.ts` uses `reaction.includes('robot')` (was `=== 'robot_face' || === 'robot'`), because workspaces add a CUSTOM `:robot:` (pixel bot ≠ standard 🤖 `robot_face`) whose event name the exact check silently dropped. Non-matching reactions log `Ignored reaction: <name>` so the real emoji name is visible.
- **`conversations.history` silently omits thread replies** — `latest=<ts>` returns nothing for a message that's a thread reply (replies aren't in channel history). Fetch a single message robustly via `conversations.replies?ts=<ts>` (accepts ANY ts in a thread, parent or reply) and match on ts. `fetchMessage` (slack/client.ts) does history-then-replies. Both reaction paths use it (👕 since the 2026-08-02 fix — before that it read raw history and skipped threaded posts). T-shirt naming falls back to image alt_text when the context line has no `*prompt*` (summon posts).
- **Slack `subtype: 'bot_message'` only exists on `response_url` webhook posts** — messages posted via `chat.postMessage` (🤖-summon delivery, threaded sends) carry `bot_id` + `user` but NO subtype. Never use subtype to detect Clank's own messages; use `isOwnMessage()` (slack/client.ts, auth.test-based). This silently broke 👕 t-shirts on summon images until 2026-08-02.

- **ElectroDB `update()` does NOT write secondary-index keys** when the index composites are only in the key (not the SET clause) — an update-created row carries `pk`/`sk` but no `gsi1pk`/`gsi1sk`, invisible to GSI queries. Use **`upsert()`** (insert-capable; writes all index keys on create, `add` applies against 0, `ifNotExists` freezes fields). Caught only by a live round-trip (`touchProfile`).
- **`op.ifNotExists(attr, val)` IS itself the SET op** in ElectroDB `.data()` — don't wrap it in `op.set(...)` (emits two overlapping SETs → "document paths overlap").
- **S3 Vectors rejects a bare multi-key filter** (`{type, tenant}` → "Invalid filter"). A single key is fine (Slack's current form); 2+ conditions must be wrapped in `$and` (`vectors.ts` `buildFilter`).
- **Discord alt text = attachment `description`** (the "ALT" badge), NOT an embed field — embeds have no per-image alt. Upload the render as a FILE with `description` to carry Clank's thoughts (Slack uses Block-Kit `alt_text`).
- **ElectroDB entities need `casing:'none'`** on every pk/sk — it lowercases keys by default (`META`→`meta`), which misses every real row + mangles case-sensitive tenant ids.
- **Verify the store against real infra** — the ElectroStore + vector isolation each had a bug (GSI write, `$and` filter) that passed typecheck AND unit key-composition tests; only a round-trip against `clank-mind-prod` caught them. Throwaway smoke scripts in `scripts/_smoke_*.ts` (delete after).

## Future Ideas
- Caption channel — post images with a one-line caption in Clank's voice (second personality channel beyond the image)
- `@Clank` mentions (Events API), emoji reactions, DM conversations (scopes ready)
- Optional deep-memory layer if relevance recall ever needs supplementing
