// ─── Async Lambda invoke ─────────────────────────────────────────
// One place for the fire-and-forget "hand off to the processor" call. Every
// Slack/Discord entry handler used to construct its own LambdaClient +
// InvokeCommand; this collapses those copies to a single client + helper.

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const client = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

/** Invoke a Lambda asynchronously (Event) with a JSON payload. Fire-and-forget. */
export async function invokeAsync(functionName: string | undefined, payload: unknown): Promise<void> {
    await client.send(
        new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'Event',
            Payload: JSON.stringify(payload),
        })
    );
}
