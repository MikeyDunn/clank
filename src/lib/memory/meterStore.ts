// ─── Global per-user wallet (the Discord metering ledger) ────────
// Discord purchases (entitlements) are USER-owned and follow the user across
// every server, so the wallet — free-daily, credits, cooldown — is keyed by the
// Discord USER ID GLOBALLY. One balance per person, usable in any server, NOT
// per guild. (Clank's MEMORY stays per-guild; only the economy is global.)
//
// Stored on the prod table under an un-tenant-prefixed key
// (pk = METER#<userId>, sk = METER), so it never collides with the TENANT#…
// memory rows and is invisible to the ElectroDB tenant queries.
//
// EVERY mutation here is a single CONDITIONAL DynamoDB update — never a
// read-modify-write. Each Discord slash command is its own Lambda, so a user's
// concurrent requests genuinely race; unconditional SETs let them bypass the
// cooldown, blow past the free cap, and double-spend a credit (all of which
// bills us). The conditional cooldown claim is the serialiser: only one
// in-flight request per user can win it, so the allowance checks behind it
// can't be raced either.

import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MeterStore, UserMeter } from './store.js';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }), {
    // Sets are used for the granted/clawed entitlement id ledgers.
    marshallOptions: { removeUndefinedValues: true },
});

const key = (userId: string) => ({ pk: `METER#${userId}`, sk: 'METER' });
// The per-GUILD free pool. Separate from the per-user wallet: a user's free
// allowance limits one person, this limits what one server can cost us in a day
// regardless of how many members it has. Paid renders never touch it.
const guildKey = (guildId: string) => ({ pk: `GUILD#${guildId}`, sk: 'METER' });

/** Run a conditional update; true = it applied, false = the condition failed. */
async function tryUpdate(input: Record<string, unknown>): Promise<boolean> {
    try {
        await doc.send(new UpdateCommand(input as any));
        return true;
    } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
    }
}

/** A wallet keyed by GLOBAL Discord user id (one balance per person). */
export function createGlobalMeterStore(tableName: string): MeterStore {
    return {
        async getUserMeter(userId: string): Promise<UserMeter> {
            const { Item } = await doc.send(new GetCommand({ TableName: tableName, Key: key(userId) }));
            return {
                freeUsedToday: Item?.freeUsedToday ?? 0,
                freeResetDate: Item?.freeResetDate ?? null,
                creditBalance: Item?.creditBalance ?? 0,
                lastRequestAt: Item?.lastRequestAt ?? null,
                givenName: Item?.givenName ?? null,
                familyInitial: Item?.familyInitial ?? null,
            };
        },

        async setNameOnce(userId: string, givenName: string, familyInitial: string | null): Promise<void> {
            await doc.send(
                new UpdateCommand({
                    TableName: tableName,
                    Key: key(userId),
                    // if_not_exists: first capture wins forever (SIWA only sends
                    // the name on the first authorization; never clobber it).
                    UpdateExpression:
                        'SET givenName = if_not_exists(givenName, :g), familyInitial = if_not_exists(familyInitial, :f)',
                    ExpressionAttributeValues: { ':g': givenName, ':f': familyInitial ?? '' },
                })
            );
        },

        // Claim the cooldown slot. Succeeds only if the user has no stamp or the
        // last one is older than the window — so of N concurrent requests exactly
        // one wins. This is what serialises a single user's traffic.
        async claimCooldown(userId: string, now: number, cooldownMs: number): Promise<boolean> {
            return tryUpdate({
                TableName: tableName,
                Key: key(userId),
                UpdateExpression: 'SET lastRequestAt = :now',
                ConditionExpression: 'attribute_not_exists(lastRequestAt) OR lastRequestAt <= :cutoff',
                ExpressionAttributeValues: { ':now': now, ':cutoff': now - cooldownMs },
            });
        },

        // Spend one free render. Two shapes: same-day increment (capped), or a
        // fresh day rolling the counter to 1.
        async consumeFree(userId: string, today: string, cap: number): Promise<boolean> {
            if (cap < 1) return false; // no free tier — go straight to credits
            const sameDay = await tryUpdate({
                TableName: tableName,
                Key: key(userId),
                UpdateExpression: 'ADD freeUsedToday :one',
                ConditionExpression: 'freeResetDate = :today AND freeUsedToday < :cap',
                ExpressionAttributeValues: { ':one': 1, ':today': today, ':cap': cap },
            });
            if (sameDay) return true;
            // Not today's date (or no row yet) → start the new day at 1.
            return tryUpdate({
                TableName: tableName,
                Key: key(userId),
                UpdateExpression: 'SET freeUsedToday = :one, freeResetDate = :today',
                ConditionExpression: 'attribute_not_exists(freeResetDate) OR freeResetDate <> :today',
                ExpressionAttributeValues: { ':one': 1, ':today': today },
            });
        },

        async getServerFreeUsed(guildId: string, today: string): Promise<number> {
            const { Item } = await doc.send(new GetCommand({ TableName: tableName, Key: guildKey(guildId) }));
            return Item?.freeResetDate === today ? Item?.freeUsedToday || 0 : 0;
        },

        // Same two-shape pattern as the per-user counter: same-day increment
        // under the cap, or roll a fresh day to 1.
        async consumeServerFree(guildId: string, today: string, cap: number): Promise<boolean> {
            if (cap < 1) return false;
            const sameDay = await tryUpdate({
                TableName: tableName,
                Key: guildKey(guildId),
                UpdateExpression: 'ADD freeUsedToday :one',
                ConditionExpression: 'freeResetDate = :today AND freeUsedToday < :cap',
                ExpressionAttributeValues: { ':one': 1, ':today': today, ':cap': cap },
            });
            if (sameDay) return true;
            return tryUpdate({
                TableName: tableName,
                Key: guildKey(guildId),
                UpdateExpression: 'SET freeUsedToday = :one, freeResetDate = :today',
                ConditionExpression: 'attribute_not_exists(freeResetDate) OR freeResetDate <> :today',
                ExpressionAttributeValues: { ':one': 1, ':today': today },
            });
        },

        // Spend one credit; fails (rather than going negative) at zero.
        async spendCredit(userId: string): Promise<boolean> {
            return tryUpdate({
                TableName: tableName,
                Key: key(userId),
                UpdateExpression: 'ADD creditBalance :minusOne',
                ConditionExpression: 'creditBalance >= :one',
                ExpressionAttributeValues: { ':minusOne': -1, ':one': 1 },
            });
        },

        // Grant a purchase EXACTLY once, ever. The entitlement id goes into a set
        // in the same conditional write as the balance bump, so a retry, a
        // concurrent reconcile, or a failed consume can never double-credit.
        async grantOnce(userId: string, entitlementId: string, amount: number): Promise<boolean> {
            return tryUpdate({
                TableName: tableName,
                Key: key(userId),
                UpdateExpression: 'ADD creditBalance :amt, grantedEnts :ent',
                ConditionExpression: 'attribute_not_exists(grantedEnts) OR NOT contains(grantedEnts, :entId)',
                ExpressionAttributeValues: {
                    ':amt': amount,
                    ':ent': new Set([entitlementId]),
                    ':entId': entitlementId,
                },
            });
        },

        // Reverse a granted pack after a refund/chargeback (ENTITLEMENT_DELETE).
        // Only claws back what's LEFT — spent credits are already gone, and the
        // balance must never go negative. Returns how many were actually removed.
        async clawback(userId: string, entitlementId: string, amount: number): Promise<number> {
            const m = await this.getUserMeter(userId);
            const take = Math.min(amount, Math.max(0, m.creditBalance || 0));
            const applied = await tryUpdate({
                TableName: tableName,
                Key: key(userId),
                UpdateExpression: 'ADD creditBalance :neg, clawedEnts :ent',
                ConditionExpression:
                    'contains(grantedEnts, :entId) AND (attribute_not_exists(clawedEnts) OR NOT contains(clawedEnts, :entId)) AND creditBalance >= :take',
                ExpressionAttributeValues: {
                    ':neg': -take,
                    ':take': take,
                    ':ent': new Set([entitlementId]),
                    ':entId': entitlementId,
                },
            });
            return applied ? take : 0;
        },
    };
}
