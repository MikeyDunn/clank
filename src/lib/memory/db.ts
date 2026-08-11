// ─── DynamoDB abstraction layer ──────────────────────────────────

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    QueryCommand,
    ScanCommand,
    UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { TABLE_NAME } from './constants.js';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const ddb = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
});

async function getItem(pk, sk) {
    const result = await ddb.send(
        new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk, sk },
        })
    );
    return result.Item || null;
}

/**
 * Query items by pk with sk prefix, sorted by sk.
 * Use forward=false for newest-first ordering.
 */
async function queryItems(
    pk: string,
    skPrefix: string,
    { limit, forward = true }: { limit?: number; forward?: boolean } = {}
): Promise<any[]> {
    const params: any = {
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': skPrefix },
        ScanIndexForward: forward,
    };
    if (limit) params.Limit = limit;
    const result = await ddb.send(new QueryCommand(params));
    return result.Items || [];
}

/**
 * Query history entries via GSI, sorted by timestamp.
 * since - Only entries after this ISO timestamp
 * limit - Max entries to return
 * forward - true=oldest first, false=newest first
 */
async function queryHistoryGSI({
    since = null,
    limit,
    forward = true,
}: {
    since?: string | null;
    limit?: number;
    forward?: boolean;
} = {}) {
    const params: any = {
        TableName: TABLE_NAME,
        IndexName: 'gsi1',
        ScanIndexForward: forward,
    };

    if (since) {
        params.KeyConditionExpression = 'gsi1pk = :pk AND gsi1sk > :since';
        params.ExpressionAttributeValues = { ':pk': 'HIST', ':since': since };
    } else {
        params.KeyConditionExpression = 'gsi1pk = :pk';
        params.ExpressionAttributeValues = { ':pk': 'HIST' };
    }

    if (limit) params.Limit = limit;
    const result = await ddb.send(new QueryCommand(params));
    return result.Items || [];
}

/**
 * Put a single item into DynamoDB.
 */
async function putItem(item) {
    await ddb.send(
        new PutCommand({
            TableName: TABLE_NAME,
            Item: item,
        })
    );
}

/**
 * Update an item in DynamoDB.
 * params - { Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues, ConditionExpression, ReturnValues }
 */
async function updateItem(params: any) {
    return ddb.send(
        new UpdateCommand({
            TableName: TABLE_NAME,
            ...params,
        })
    );
}

/**
 * Query with full control over params (for custom queries like COUNT).
 */
async function queryRaw(params) {
    return ddb.send(
        new QueryCommand({
            TableName: TABLE_NAME,
            ...params,
        })
    );
}

/**
 * Scan for all user profiles (sk = 'PROFILE', pk starts with 'USER#').
 * Small table (~10 users) so scan is fine.
 */
async function scanUserProfiles() {
    let items: any[] = [];
    let lastKey: any;
    do {
        const result = await ddb.send(
            new ScanCommand({
                TableName: TABLE_NAME,
                FilterExpression: 'sk = :profile AND begins_with(pk, :userPrefix)',
                ExpressionAttributeValues: { ':profile': 'PROFILE', ':userPrefix': 'USER#' },
                ExclusiveStartKey: lastKey,
            })
        );
        items = items.concat(result.Items || []);
        lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return items;
}

export { getItem, putItem, queryHistoryGSI, queryItems, queryRaw, scanUserProfiles, updateItem };
