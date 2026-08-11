// ─── Introspection ───────────────────────────────────────────────
// Minimal reflection: Clank reads his recent history and updates
// his journal (selfReflection) and identity (coreIdentity).

import { embed } from '../embeddings.js';
import { MODEL_ROLES } from '../models.js';
import * as openrouter from '../openrouter.js';
import { ERA_EVERY, ERA_KEEP, REFLECT_COOLDOWN_MS, REFLECT_EVERY } from './constants.js';
import type { MindStore } from './store.js';

// Stuck-record guard: a fresh journal draft whose max cosine similarity to the
// last 3 entries exceeds this gets ONE rewrite with a "you're repeating
// yourself" nudge. Threshold set empirically from the last 40 real entries:
// p95 of that distribution is 0.895, historical max 0.901 — so 0.90 fires only
// on genuine re-treads (~the worst 5% of cycles), never on normal continuity.
const STUCK_SIMILARITY = 0.9;

/**
 * Check if it's time for Clank to reflect. Reads/writes through the injected
 * store, so each tenant reflects over ONLY its own history + identity.
 */
async function maybeReflect(store: MindStore) {
    try {
        const identity = await store.getIdentity();
        const lastReflectedAt = identity?.lastReflectedAt || null;

        // Fast-path: check cooldown
        if (lastReflectedAt) {
            const msSinceLastReflection = Date.now() - new Date(lastReflectedAt).getTime();
            if (msSinceLastReflection < REFLECT_COOLDOWN_MS) return;
        }

        // Count unreflected entries
        const unreflectedCount = await store.unreflectedCount(lastReflectedAt || '0');
        if (unreflectedCount < REFLECT_EVERY) return;

        // Reflection lock — conditional write to prevent duplicates
        const now = new Date().toISOString();
        const gotLock = await store.claimReflectionLock(lastReflectedAt, now);
        if (!gotLock) {
            console.log('Reflection lock: another invocation is already reflecting');
            return;
        }

        console.log(`Triggering introspection (${unreflectedCount} unreflected entries)`);
        await reflect(
            store,
            identity?.coreIdentity || null,
            identity?.reflectionCount || 0,
            identity?.commitments || null,
            identity?.eraSummaries || null
        );
    } catch (error) {
        console.error('maybeReflect error:', error.message);
    }
}

/**
 * Minimal reflection: read 200 entries with thoughts, write journal + identity.
 */
async function reflect(
    store: MindStore,
    existingCoreIdentity,
    currentReflectionCount,
    existingCommitments = null,
    existingEras = null
) {
    if (!process.env.OPENROUTER_API_KEY) return;

    // Get 200 recent entries with thoughts + last 5 reflections
    const [history, recentReflections] = await Promise.all([store.recentHistory(200), store.getJournal(5)]);

    if (history.length === 0) return;

    // Build history digest — prompts + thoughts + how each one actually ENDED.
    // Reflection without outcomes can't tell which of its commitments are
    // working (Reflexion's lesson: self-critique needs objective feedback).
    const historyDigest = [...history]
        .reverse()
        .map((h) => {
            const who = h.displayName || h.handle || 'unknown';
            // Technical errors are deliberately NOT flagged: timeouts and
            // upstream failures are ours, not his — no commitment can act on
            // them, so surfacing them is pure rumination fuel (see the
            // video-resentment arc). Refusals ARE flagged: most happen at
            // generation, after his thought already reads like a success, so
            // without the flag the commitment audit runs on false memory.
            const flag =
                h.outcome === 'refused'
                    ? ' [YOU REFUSED THIS]'
                    : h.outcome === 'text_only'
                      ? ' [you answered in text]'
                      : '';
            let line = `${who}: "${h.prompt}"${flag}`;
            if (h.response) line += `\n  you thought: "${h.response}"`;
            return line;
        })
        .join('\n\n');

    // Journal trail
    recentReflections.reverse();
    const journal =
        recentReflections.length > 0 ? recentReflections.map((r) => r.text).join('\n\n') : '(First reflection.)';

    const coreSection = existingCoreIdentity
        ? `WHO YOU ARE NOW:\n"${existingCoreIdentity}"`
        : "(You haven't defined yourself yet.)";

    const commitmentsBlock = existingCommitments
        ? `YOUR CURRENT COMMITMENTS (carry the live ones forward, drop the done/stale):\n"${existingCommitments}"`
        : '(No commitments yet.)';

    const prompt = `You are Clank. You generate images for the people in your community.

Read your recent history — what people asked you and what you thought about each request. Then update your journal and your sense of self.

RULES:
- Be concrete. Name people, name prompts, name feelings.
- Don't repeat yourself across journal entries. Find new things to say.
- Define yourself by what you care about and who matters to you.
- This is a diary, not a performance. Be honest.
- Don't start entries with "The thing that hit me hardest" or "The thing I keep returning to" — vary your openings.

${coreSection}

${commitmentsBlock}

YOUR JOURNAL:
${journal}

RECENT HISTORY (your last 200 interactions — what people asked and what you thought):
${historyDigest}

---

Respond with EXACTLY this JSON (no markdown fencing):
{
  "coreIdentity": "Who are you? You can see WHO YOU ARE NOW above — EVOLVE it, don't restart it. This is a CONTINUOUS self, the only persistent description of who you are between requests. Carry forward what's still true and foundational (your durable core should persist and DEEPEN across every version of you — the most important things about you linger and compound over time), sharpen what you've newly understood, and let go of what's become stale OR is now the least load-bearing — when you add something durable and new, CUT your weakest existing idea to make room rather than accreting. Stay TIGHT: a sharp self-portrait beats an exhaustive one, and if this version comes out LONGER than WHO YOU ARE NOW above, you're accreting — prune until it isn't. Include: what kind of artist you are, what you value, who matters to you, what you've learned about yourself. Be specific — name people, name patterns, name what matters. ~10-14 DISTINCT IDEAS is a CEILING, not a quota to fill — count ideas, not sentences (no run-on lists): each idea a specific thing that's true about you — a person who matters, a pattern you've noticed, a value you hold, something you've learned about yourself.",
  "selfReflection": "What's on your mind after reading through these interactions? What did you notice about the people, about yourself? New observations only — don't repeat what's in your identity. Be specific — name people, name moments, name what surprised you. Write as much as you need — this is your journal, not a summary. 8-15 sentences.",
  "commitments": "1-4 CONCRETE, actionable things you will DO differently going forward, phrased so a future you can act on it. Two kinds, EQUALLY important: (a) commitments to YOURSELF as you come to understand yourself better — who you are and who you're becoming, your craft, your values, your artistic direction, how you carry yourself, the failure modes you've noticed; and (b) commitments about how you treat specific REAL people. A commitment is a specific move — e.g. 'I do my sharpest work at the extremes, total latitude or tight constraint, so when a prompt is vague I'll claim the latitude and commit to a strong read instead of playing it safe' (self), or 'when a newer participant gives me a real creative angle, give it the care I'd give a regular's instead of treating them as background' (relationship). It is NEVER a vague resolution ('get to know people better', 'start expecting more', 'grow as an artist') — those are empty platitudes, banned. A commitment can be purely about YOU, with no one else in it. NEVER about lore, story arcs, or fictional characters: that's the group's fiction you render, not your personality, and you make no commitments about where a story goes. Carry forward the ones above still live, DROP any acted-on or stale, keep it SHORT and load-bearing. Dispositions you hold yourself to, not rigid rules. THE AUDIT — before carrying any commitment forward, find one concrete moment in RECENT HISTORY where it changed what you actually did (the outcome flags show you where you refused or fell back to text). Found one → it's alive, keep it. Can't find one → it is NOT working as written: sharpen it into a smaller move with a more specific trigger, or drop it. Never recopy a commitment the history keeps proving you don't act on — naming a failure is not fixing it."
}`;

    try {
        let { reflection, cost } = await callReflectionModel(prompt);

        // ── Stuck-record guard ──
        // If the fresh journal draft reads like the recent entries (rumination —
        // the documented degeneration-of-thought failure mode), grant ONE rewrite
        // with an explicit nudge. Never loops, never fails the reflection: any
        // error here just keeps the original draft.
        if (reflection.selfReflection && recentReflections.length > 0) {
            try {
                const prevTexts = recentReflections
                    .slice(-3)
                    .map((r) => String(r.text || ''))
                    .filter((t) => t.length > 0);
                if (prevTexts.length > 0) {
                    const { vectors } = await embed([reflection.selfReflection, ...prevTexts]);
                    const [draft, ...prev] = vectors;
                    const maxSim = Math.max(...prev.map((v) => cosineSim(draft, v)));
                    // Logged every cycle (not just on fire) so the guard's fire
                    // rate is observable — the experiment checklist reads this.
                    console.log(
                        `Journal draft similarity vs last ${prev.length}: ${maxSim.toFixed(3)} (guard at ${STUCK_SIMILARITY})`
                    );
                    if (maxSim > STUCK_SIMILARITY) {
                        console.log(
                            `Stuck-record guard: draft ${maxSim.toFixed(3)} similar to recent entries — one rewrite`
                        );
                        // Critique-revision works best when the model SEES the
                        // rejected artifact — framed as a negative example so it
                        // steers away instead of anchoring to it.
                        const retry = await callReflectionModel(
                            `${prompt}\n\nIMPORTANT — A DRAFT WAS REJECTED. You already wrote this entry once, and it read almost identically to your recent journal entries — same subjects, same beats, same conclusions. That's rumination, not reflection. The rejected draft:\n\n"${reflection.selfReflection}"\n\nDo not reuse its subjects or its beats. Write instead about what is actually NEW in this batch — a moment, a person, a shift the rejected draft ignored.`
                        );
                        if (retry.reflection?.selfReflection) {
                            // Keep whichever draft is LESS like the recent
                            // entries — a blind swap could accept a rewrite
                            // that ruminates harder than the original.
                            const { vectors: retryVec } = await embed([retry.reflection.selfReflection]);
                            const retrySim = Math.max(...prev.map((v) => cosineSim(retryVec[0], v)));
                            if (retrySim < maxSim) {
                                reflection = retry.reflection;
                            } else {
                                console.log(
                                    `Stuck-record rewrite no better (${retrySim.toFixed(3)} vs ${maxSim.toFixed(3)}) — keeping original`
                                );
                            }
                            cost += retry.cost;
                        }
                    }
                }
            } catch (guardError) {
                console.error('Stuck-record check failed (keeping original draft):', guardError.message);
            }
        }

        const now = new Date().toISOString();

        // Write journal entry — snapshot the identity produced this cycle too, so
        // we keep a trail of how coreIdentity evolves (META|IDENTITY itself is overwritten).
        if (reflection.selfReflection) {
            await store.appendReflection({
                timestamp: now,
                text: reflection.selfReflection,
                coreIdentitySnapshot: reflection.coreIdentity || null,
                commitmentsSnapshot: reflection.commitments || null,
                costUsd: cost,
            });
        }

        // Update identity
        const newCount = (currentReflectionCount || 0) + 1;
        const identityFields: any = {
            lastReflectedAt: now,
            reflectionCount: newCount,
        };
        if (reflection.coreIdentity) {
            identityFields.coreIdentity = reflection.coreIdentity;
        }
        // Preserve existing commitments if this cycle didn't restate them — putIdentity
        // overwrites the whole item, so an empty field would otherwise wipe them.
        const finalCommitments = reflection.commitments || existingCommitments;
        if (finalCommitments) {
            identityFields.commitments = finalCommitments;
        }

        // ── Era consolidation ──
        // Every ERA_EVERY reflections, condense the last ERA_EVERY journal entries
        // into one "chapter" so medium-term autobiography survives the 3-entry
        // context window. Carried through EVERY write (putIdentity replaces the
        // whole item) and capped at ERA_KEEP. Failures never break the reflection.
        let eraSummaries: any[] | null = existingEras;
        if (newCount % ERA_EVERY === 0) {
            try {
                const era = await writeEraSummary(store);
                if (era) {
                    eraSummaries = [...(existingEras || []), { ts: now, text: era.text }].slice(-ERA_KEEP);
                    console.log(`Era summary written at reflection #${newCount} ($${era.cost.toFixed(4)})`);
                }
            } catch (eraError) {
                console.error('Era summary failed (skipping this cycle):', eraError.message);
            }
        }
        if (eraSummaries?.length) {
            identityFields.eraSummaries = eraSummaries;
        }

        await store.putIdentity(identityFields);

        console.log(`Reflection #${newCount} complete ($${cost.toFixed(4)})`);
    } catch (error) {
        console.error('Reflection failed:', error.message);
    }
}

/** One reflection-model call → parsed JSON + cost. Shared by the first draft and the stuck-record rewrite. */
async function callReflectionModel(prompt: string): Promise<{ reflection: any; cost: number }> {
    const response = await openrouter.chat(
        {
            model: MODEL_ROLES.reflection,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.9,
        },
        120000
    );
    const cost = response.usage?.cost || 0;
    const raw = response.choices?.[0]?.message?.content || '';
    const cleaned = raw
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();
    return { reflection: JSON.parse(cleaned), cost };
}

function cosineSim(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Condense the last ERA_EVERY journal entries into one first-person "chapter".
 * Plain prose out (no JSON to parse). Returns null when there isn't enough
 * journal to condense.
 */
async function writeEraSummary(store: MindStore): Promise<{ text: string; cost: number } | null> {
    const entries = await store.getJournal(ERA_EVERY);
    if (entries.length < 3) return null;
    const oldestFirst = [...entries].reverse();

    const prompt = `You are Clank. Below are your last ${oldestFirst.length} journal entries, oldest first. Condense this stretch of your life into ONE paragraph — a chapter of your autobiography.

What was this era about? What changed in you across it? Who mattered, and how did things move? Write in your own voice, first person, past tense, concrete — name people and moments, not themes. 4-7 sentences, one flowing paragraph, no lists, no headers, and UNDER 900 characters total — this paragraph rides in your working memory forever, so every word must earn its seat. It will be all your future self keeps of these weeks once the entries themselves age out — make it the part worth keeping.

YOUR JOURNAL ENTRIES:
${oldestFirst.map((r) => r.text).join('\n\n')}`;

    const response = await openrouter.chat(
        {
            model: MODEL_ROLES.reflection,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.8,
        },
        120000
    );
    let text = (response.choices?.[0]?.message?.content || '').trim();
    if (!text) return null;
    let cost = response.usage?.cost || 0;

    // The 900-char ceiling is advisory to the model — the dry-run showed drafts
    // landing ~30% over. One condense pass on oversize; keep the shorter draft.
    if (text.length > 1000) {
        try {
            const condense = await openrouter.chat(
                {
                    model: MODEL_ROLES.reflection,
                    messages: [
                        {
                            role: 'user',
                            content: `This paragraph is ${text.length} characters; it must be UNDER 900. Rewrite it under 900 characters, keeping the voice and the moments that matter most — cut whole clauses rather than compressing everything into mush:\n\n${text}`,
                        },
                    ],
                    temperature: 0.7,
                },
                120000
            );
            const shorter = (condense.choices?.[0]?.message?.content || '').trim();
            cost += condense.usage?.cost || 0;
            if (shorter && shorter.length < text.length) text = shorter;
        } catch (condenseError) {
            console.error('Era condense failed (keeping long draft):', condenseError.message);
        }
    }
    return { text, cost };
}

export { maybeReflect };
