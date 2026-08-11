#!/usr/bin/env node

// ─── Clank Status Report ─────────────────────────────────────────
// Queries DynamoDB for a mind snapshot + scans CloudWatch for errors.
// Usage: AWS_PROFILE=<your-profile> node scripts/report.js
//
// Outputs:
//   tmp/{timestamp}.json  — last 5 history, all users, identity, last 2 reflections
//   Console              — error summary + status

import { mkdirSync, writeFileSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TABLE = process.env.DYNAMODB_TABLE || 'clank-mind-dev';
const REGION = 'us-east-1';
const STAGE = 'dev';
const SERVICE = 'clank-image-generator';
const LOG_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const FUNCTIONS = ['slackImageCommand', 'slackInteraction', 'imageProcessor'];

async function run() {
    const client = new DynamoDBClient({ region: REGION });
    const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
    const cwl = new CloudWatchLogsClient({ region: REGION });

    // ── 1. Build mind snapshot ──────────────────────────────────

    // Last 5 history entries (newest first via GSI)
    const historyResult = await ddb.send(
        new QueryCommand({
            TableName: TABLE,
            IndexName: 'gsi1',
            KeyConditionExpression: 'gsi1pk = :pk',
            ExpressionAttributeValues: { ':pk': 'HIST' },
            ScanIndexForward: false,
            Limit: 5,
        })
    );
    const history = (historyResult.Items || []).map((h) => ({
        historyId: h.historyId,
        prompt: h.prompt,
        handle: h.handle,
        displayName: h.displayName,
        userId: h.userId,
        response: h.response,
        outcome: h.outcome,
        source: h.source,
        model: h.model,
        cost: h.cost,
        totalCost: h.totalCost,
        regenerations: h.regenerations,
        thoughts: h.response,
        timestamp: h.timestamp,
    }));

    // All users — scan for USER# PROFILE items.
    // MUST paginate: a Scan caps at 1MB BEFORE the filter runs, so with 1000s of
    // HIST# items the PROFILE rows spill past page one and silently vanish.
    const profileItems: any[] = [];
    let lastKey: Record<string, any> | undefined;
    do {
        const userScan = await ddb.send(
            new ScanCommand({
                TableName: TABLE,
                FilterExpression: 'begins_with(pk, :prefix) AND sk = :sk',
                ExpressionAttributeValues: { ':prefix': 'USER#', ':sk': 'PROFILE' },
                ExclusiveStartKey: lastKey,
            })
        );
        profileItems.push(...(userScan.Items || []));
        lastKey = userScan.LastEvaluatedKey;
    } while (lastKey);

    const users: Record<string, any> = {};
    for (const item of profileItems) {
        const uid = item.pk.replace('USER#', '');
        users[uid] = {
            userId: uid,
            handle: item.handle,
            displayName: item.displayName,
            firstSeen: item.firstSeen,
            lastSeen: item.lastSeen,
            requestCount: item.requestCount,
        };
    }

    // Identity metadata
    const identityResult = await ddb.send(
        new QueryCommand({
            TableName: TABLE,
            KeyConditionExpression: 'pk = :pk AND sk = :sk',
            ExpressionAttributeValues: { ':pk': 'META', ':sk': 'IDENTITY' },
        })
    );
    const identity = identityResult.Items?.[0] || {};

    // Last 2 reflections
    const reflectionResult = await ddb.send(
        new QueryCommand({
            TableName: TABLE,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': 'META', ':prefix': 'REFLECTION#' },
            ScanIndexForward: false,
            Limit: 2,
        })
    );
    const reflections = (reflectionResult.Items || []).map((r) => ({ text: r.text, timestamp: r.timestamp })).reverse();

    // Total history count
    const countResult = await ddb.send(
        new QueryCommand({
            TableName: TABLE,
            IndexName: 'gsi1',
            KeyConditionExpression: 'gsi1pk = :pk',
            ExpressionAttributeValues: { ':pk': 'HIST' },
            Select: 'COUNT',
        })
    );

    const report = {
        generatedAt: new Date().toISOString(),
        summary: {
            totalHistory: countResult.Count || 0,
            totalUsers: Object.keys(users).length,
            reflectionCount: identity.reflectionCount || 0,
            lastReflectedAt: identity.lastReflectedAt || null,
            coreIdentity: identity.coreIdentity || null,
        },
        history,
        users,
        reflections,
    };

    // Write to tmp/
    const tmpDir = path.join(__dirname, '..', 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}.json`;
    const filepath = path.join(tmpDir, filename);
    writeFileSync(filepath, JSON.stringify(report, null, 2));
    console.log(`Report written: tmp/${filename}`);
    console.log('');

    // ── 2. Scan CloudWatch for errors ───────────────────────────

    const since = Date.now() - LOG_WINDOW_MS;
    let totalErrors = 0;
    const errorsByFunction: Record<string, any> = {};

    for (const fn of FUNCTIONS) {
        const logGroup = `/aws/lambda/${SERVICE}-${STAGE}-${fn}`;
        try {
            const result = await cwl.send(
                new FilterLogEventsCommand({
                    logGroupName: logGroup,
                    startTime: since,
                    filterPattern: 'ERROR',
                    limit: 10,
                })
            );
            const events = result.events || [];
            if (events.length > 0) {
                totalErrors += events.length;
                errorsByFunction[fn] = events.slice(0, 3).map((e) => ({
                    timestamp: new Date(e.timestamp || 0).toISOString(),
                    message: (e.message || '').trim().substring(0, 200),
                }));
            }
        } catch (err) {
            if (err.name === 'ResourceNotFoundException') {
                // Log group doesn't exist yet — that's fine
            } else {
                console.error(`  Failed to query ${logGroup}: ${err.message}`);
            }
        }
    }

    // ── 3. Print status report ──────────────────────────────────

    console.log('═══════════════════════════════════════════════');
    console.log('  CLANK STATUS REPORT');
    console.log('═══════════════════════════════════════════════');
    console.log('');

    console.log('MIND SNAPSHOT');
    console.log(`  Total history entries: ${report.summary.totalHistory}`);
    console.log(`  Users: ${report.summary.totalUsers}`);
    console.log(`  Reflections: ${report.summary.reflectionCount}`);
    console.log(`  Last reflected: ${report.summary.lastReflectedAt || 'never'}`);
    console.log('');

    console.log('LAST 5 REQUESTS');
    for (const h of history) {
        const name = h.displayName || h.handle || h.userId;
        const cost = h.totalCost > 0 ? `$${h.totalCost.toFixed(4)}` : 'free';
        console.log(
            `  [${h.timestamp?.split('T')[0]}] ${name}: "${h.prompt?.substring(0, 50)}" → ${h.outcome} [${h.source || '—'}] ${cost}`
        );
    }
    console.log('');

    console.log('USERS');
    for (const [uid, u] of Object.entries(users)) {
        const name = u.displayName || u.handle || uid;
        console.log(`  ${name} — ${u.requestCount} requests, last seen ${u.lastSeen?.split('T')[0] || 'unknown'}`);
    }
    console.log('');

    console.log('ERRORS (last 24h)');
    if (totalErrors === 0) {
        console.log('  All clean — no errors found.');
    } else {
        console.log(`  ${totalErrors} error(s) found:`);
        for (const [fn, errors] of Object.entries(errorsByFunction)) {
            console.log(`  ${fn}:`);
            for (const e of errors) {
                console.log(`    [${e.timestamp}] ${e.message}`);
            }
        }
    }
    console.log('');
    console.log('═══════════════════════════════════════════════');
}

run().catch((err) => {
    console.error('Report failed:', err);
    process.exit(1);
});
