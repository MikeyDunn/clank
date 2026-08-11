// ─── Clank's brain ───────────────────────────────────────────────
// Sonnet processes every request: decides image vs text, writes thoughts,
// and crafts detailed image prompts that resolve lore/appearance/context.

import { RESPONSE_TOOL, THINK_PROMPT } from '../../prompts/think.js';
import { executeLoreTool, LORE_TOOLS } from '../loreTools.js';
import { MODEL_ROLES } from '../models.js';
import * as openrouter from '../openrouter.js';
import { LEGACY_SCOPE, type VectorScope } from '../vectors.js';
import { REACTED_MARKER } from './summon.js';

// Source-message context for the "Ask Clank" shortcut (the quoted original).
export interface MessageContext {
    text?: string;
    author?: string;
}
// The 🤖-reaction social triangle: who summoned Clank onto whose message, plus
// the optional surrounding-conversation transcript. Shared with pipeline.ts.
export interface SummonContext {
    author?: string | null;
    summoner?: string | null;
    self?: boolean;
    conversation?: string | null;
}

// Lore-recall tools + the final-answer tool, sent every turn.
const TOOLS = [...LORE_TOOLS, RESPONSE_TOOL];
// Tool-loop budget. On the final turn we drop the lore tools and force
// submitResponse (see the think loop) — otherwise dense-lore requests (e.g. the
// huge "stank" cluster) can spend every turn recalling and never submit, which
// surfaces to the user as "Something went wrong".
const MAX_TURNS = 8;

/**
 * Assemble the user-turn text: the prompt, prefixed (when present) with the
 * source-message context (Ask Clank) and the requester identity, so that
 * "me/my/I" in the prompt resolve to the right person. Pure.
 */
function buildUserContent(
    prompt: string,
    messageContext: MessageContext | null = null,
    requester: string | null = null,
    summon: SummonContext | null = null
): string {
    // ── Reaction trigger: someone 🤖'd a message to summon Clank onto it. ──
    // The message text IS the thing to respond to, and it's the AUTHOR's words —
    // so the author owns the first person. The summoner is a third party who
    // pointed Clank at it; we must NOT tell Clank "me = summoner", or an author's
    // "draw me" would render the wrong face. This social triangle (who summoned
    // whom) is the whole personality hook — hand Clank the facts, let him read it.
    if (summon) {
        const author = summon.author ? `@${summon.author}` : 'someone';
        const summoner = summon.summoner ? `@${summon.summoner}` : 'someone';

        // With surrounding conversation: give it as CONTEXT ONLY. The reacted
        // message stays the request — the group may be riffing back-and-forth on a
        // premise, and Clank needs that premise, but he answers the ONE message he
        // was summoned onto. Anti-dilution instruction is explicit and repeated.
        if (summon.conversation) {
            const who = summon.self
                ? `${author} reacted to their OWN message with 🤖`
                : `${summoner} reacted with 🤖 to summon you onto ${author}'s message`;
            const firstPerson = summon.self
                ? `Any "I"/"me"/"my" in the reacted message is ${author}.`
                : `Any "I"/"me"/"my" in the reacted message is ${author} talking, NOT ${summoner}.`;
            return `[${who}. Below is the recent conversation ONLY so you understand the premise they're riffing on. Do NOT respond to the whole conversation or blend the messages together — respond as Clank to the SINGLE message marked "${REACTED_MARKER}", using the rest only as context for what it means. ${firstPerson}]

RECENT CONVERSATION (context — read for the premise, do not answer these):
${summon.conversation}`;
        }

        if (summon.self) {
            return `[${author} reacted to their OWN message with 🤖 to summon you — they want you to run with what they said here. Respond as Clank. Any "I"/"me"/"my" below is ${author}.]\n\n${prompt}`;
        }
        return `[${summoner} reacted with 🤖 to summon you onto ${author}'s message — they want YOUR take on it. Respond to the message as Clank (draw it, riff on it, or rarely just speak). Any "I"/"me"/"my" in the message below is ${author} talking, NOT ${summoner}.]\n\n${prompt}`;
    }

    let userContent = prompt;
    if (messageContext?.text) {
        const author = messageContext.author ? `@${messageContext.author}` : 'someone';
        userContent = `[Original message from ${author}: "${messageContext.text}"]\n\n${prompt}`;
    }
    if (requester) {
        // Identify the asker right next to the prompt — not only via the marker
        // buried in the system context — so "draw me"/"I"/"my" always resolve.
        userContent = `[This request is from ${requester} — the person talking to you right now. "me"/"my"/"I" refer to them.]\n\n${userContent}`;
    }
    return userContent;
}

async function think(
    prompt: string,
    context: string,
    referenceImageBase64: string | null = null,
    messageContext: MessageContext | null = null,
    requester: string | null = null,
    tokenMap: Record<string, string[]> = {},
    summon: SummonContext | null = null,
    modelOverride: string | null = null,
    vectorScope: VectorScope = LEGACY_SCOPE
) {
    const startTime = Date.now();
    const model = modelOverride || MODEL_ROLES.text; // override for local A/B evals

    const userContent = buildUserContent(prompt, messageContext, requester, summon);

    // System prompt + context is the large static prefix — cache it so the
    // tool-loop turns re-read it at ~1/10th price (confirmed ~90% cheaper).
    // Typed loosely: the array accretes system/user/assistant/tool messages
    // (OpenAI-compatible shapes) across the loop.
    const messages: any[] = [
        {
            role: 'system',
            content: [{ type: 'text', text: THINK_PROMPT + context, cache_control: { type: 'ephemeral' } }],
        },
        {
            role: 'user',
            content: referenceImageBase64
                ? [
                      { type: 'image_url', image_url: { url: referenceImageBase64 } },
                      { type: 'text', text: userContent },
                  ]
                : userContent,
        },
    ];

    let cost = 0;
    const toolLog: any[] = [];

    try {
        // Clank recalls lore via tools, then submits his answer via the
        // submitResponse tool — constrained decoding guarantees its shape, so
        // there's no JSON-in-prose to extract or repair.
        for (let turn = 0; turn < MAX_TURNS; turn++) {
            // Final turn: strip the lore tools and force a submitResponse so Clank
            // MUST answer with the lore he's already gathered instead of recalling
            // into exhaustion. tool_choice pins the one allowed tool.
            const lastTurn = turn === MAX_TURNS - 1;
            const body: any = { model, messages, tools: lastTurn ? [RESPONSE_TOOL] : TOOLS };
            if (lastTurn) body.tool_choice = { type: 'function', function: { name: 'submitResponse' } };
            const response = await openrouter.chat(body, 60000);
            cost += response.usage?.cost || 0;
            const msg = response.choices?.[0]?.message;
            if (!msg) break;
            messages.push(msg);

            const calls = msg.tool_calls || [];

            // Final answer: submitResponse carries the structured result.
            const submit = calls.find((tc) => tc.function?.name === 'submitResponse');
            if (submit) {
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                try {
                    const result = JSON.parse(submit.function.arguments || '{}');
                    console.log(
                        `Think: type=${result.type} (${duration}s, $${cost.toFixed(4)}, recalls=${JSON.stringify(toolLog)})`
                    );
                    return { ...result, cost };
                } catch {
                    console.error(
                        'Think: submitResponse args unparseable:',
                        (submit.function.arguments || '').substring(0, 300)
                    );
                    return {
                        type: 'text',
                        thoughts: '',
                        response: '',
                        cost,
                        error: { type: 'NO_ANSWER', message: 'bad submitResponse args' },
                    };
                }
            }

            // Otherwise these are lore recalls — execute them and loop.
            if (calls.length) {
                for (const tc of calls) {
                    let args: any = {};
                    try {
                        args = JSON.parse(tc.function.arguments || '{}');
                    } catch {
                        /* ignore */
                    }
                    const results = await executeLoreTool(tc.function.name, args, tokenMap, vectorScope);
                    toolLog.push({
                        t: tc.function.name === 'getEntityLore' ? 'E' : 'S',
                        a: args.name || args.query,
                        n: results.length,
                    });
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(results) });
                }
                continue;
            }

            // No tool calls — Clank answered in prose instead of submitting.
            // Nudge him once to use the tool, then loop.
            messages.push({ role: 'user', content: 'Deliver your answer now by calling submitResponse.' });
        }
        console.error('Think: no submitResponse after tool loop');
        return {
            type: 'text',
            thoughts: '',
            response: '',
            cost,
            error: { type: 'NO_ANSWER', message: 'no structured answer' },
        };
    } catch (error) {
        console.error('Think error:', error.response?.data?.error?.message || error.message);
        return { type: 'text', thoughts: '', response: '', cost, error };
    }
}

export { buildUserContent, think };
