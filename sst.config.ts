/// <reference path="./.sst/platform/config.d.ts" />

// Clank infrastructure (SST / Ion). Replaces serverless.yml.
//
// Stateful resources hold Clank's data, so SST does NOT manage them — the
// DynamoDB table, the S3 Vectors bucket, AND the images bucket are referenced
// by name + IAM only, so a deploy/remove can never recreate or drop them.
// SST owns the *compute*: the four Lambdas, the REST API, and the custom domain.
export default $config({
    app(input) {
        const prod = input?.stage === 'production';
        return {
            name: 'clank',
            removal: 'retain',
            protect: prod,
            home: 'aws',
            providers: { aws: { region: 'us-east-1', profile: process.env.AWS_PROFILE || 'default' } },
        };
    },
    async run() {
        // ── Marketing site — isolated stage: `sst deploy --stage site` ──────
        // Static landing + /terms + /privacy on <your-site>. It lives in its OWN
        // stage so it shares NO Pulumi state with the bot stages: deploying the
        // site can never touch the Lambdas/API, and a bot deploy never touches
        // the site. DNS auto-resolves via the <your-site> Route 53 hosted zone
        // (auto-created when the domain is registered in Route 53).
        if ($app.stage === 'site') {
            // SITE_PREVIEW=1 deploys to the bare CloudFront URL (no custom domain)
            // so the site can go live BEFORE <your-site> is registered. Once the
            // domain exists, a plain `npm run deploy:site` attaches <your-site>.
            const site = new sst.aws.StaticSite('MarketingSite', {
                path: 'site',
                // clank.fyi is a public marketing domain — hardcoded (not a secret,
                // unlike the account-id ARNs below which stay env-driven).
                ...(process.env.SITE_PREVIEW ? {} : { domain: { name: 'clank.fyi', dns: sst.aws.dns() } }),
            });
            return { site: site.url };
        }

        const REGION = 'us-east-1';

        // STATEFUL STAYS EXTERNAL (by design): the DynamoDB table and S3 Vectors
        // bucket are referenced by name + IAM, never managed by SST. Two reasons:
        // (1) decoupling the data lifecycle from compute deploys is the safe,
        // mature pattern — no deploy/remove can ever touch Clank's mind; (2) S3
        // Vectors is too new for the IaC providers to manage anyway. Revisit only
        // if we ever want multiple from-scratch environments.
        const TABLE = 'clank-mind-dev';
        const VECTOR_BUCKET = 'clank-memory-vectors-dev';
        // Images bucket holds data too → referenced externally, not created by SST
        // (same rule as table/vectors), so old and new images stay in one place.
        const IMAGES_BUCKET = 'clank-image-generator-images-dev';

        // Live bot is api.<your-base-domain>; any other stage gets a throwaway subdomain
        // (same shared cert) so the domain handover can be dry-run without
        // touching live — e.g. `sst deploy --stage dryrun` → dryrun.<your-base-domain>.
        const stage = $app.stage;
        // Base domain from env so the repo carries no operator identity. Live
        // bot is api.<BASE>; other stages get a throwaway <stage>.<BASE>.
        const BASE_DOMAIN = process.env.API_BASE_DOMAIN || '';
        const DOMAIN = stage === 'dev' ? `api.${BASE_DOMAIN}` : `${stage}.${BASE_DOMAIN}`;
        // SHARED infra (other projects live in this account/zone): reuse the
        // existing *.<your-base-domain> wildcard cert — do NOT let SST create/manage one.
        const CERT_ARN = process.env.ACM_CERT_ARN || '';
        const SHARP_LAYER = process.env.SHARP_LAYER_ARN || '';

        const environment = {
            OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
            SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET || '',
            SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
            PRINTIFY_API_KEY: process.env.PRINTIFY_API_KEY || '',
            DYNAMODB_TABLE_NAME: TABLE,
            S3_BUCKET_NAME: IMAGES_BUCKET,
            VECTOR_DUAL_WRITE: process.env.VECTOR_DUAL_WRITE || 'true',
        };

        // IAM for the externally-managed data stores.
        const dataPermissions = [
            {
                actions: [
                    'dynamodb:PutItem',
                    'dynamodb:GetItem',
                    'dynamodb:UpdateItem',
                    'dynamodb:Query',
                    'dynamodb:Scan',
                ],
                resources: [
                    `arn:aws:dynamodb:${REGION}:*:table/${TABLE}`,
                    `arn:aws:dynamodb:${REGION}:*:table/${TABLE}/index/*`,
                ],
            },
            {
                actions: [
                    's3vectors:PutVectors',
                    's3vectors:QueryVectors',
                    's3vectors:GetVectors',
                    's3vectors:DeleteVectors',
                    's3vectors:ListVectors',
                ],
                resources: [
                    `arn:aws:s3vectors:${REGION}:*:bucket/${VECTOR_BUCKET}`,
                    `arn:aws:s3vectors:${REGION}:*:bucket/${VECTOR_BUCKET}/index/*`,
                ],
            },
            {
                actions: ['s3:PutObject', 's3:GetObject'],
                resources: [`arn:aws:s3:::${IMAGES_BUCKET}/*`],
            },
        ];

        // Async worker — requires sharp (kept in the layer, external from the bundle).
        // vLLM (Wolf's self-hosted image model) env is scoped HERE only — generate.ts
        // is the sole consumer, and the API Lambdas have no reason to hold the key.
        // Both blank in prod → OpenRouter only; set in .env → vLLM-first with fallback.
        const processor = new sst.aws.Function('Processor', {
            handler: 'src/handlers/slack/processor.processImage',
            runtime: 'nodejs22.x',
            timeout: '300 seconds',
            memory: '1024 MB',
            layers: [SHARP_LAYER],
            nodejs: { esbuild: { external: ['sharp'] } },
            environment: {
                ...environment,
                VLLM_IMAGE_URL: process.env.VLLM_IMAGE_URL || '',
                VLLM_API_KEY: process.env.VLLM_API_KEY || '',
            },
            permissions: dataPermissions,
        });

        // ── Discord (multi-tenant, on the PROD stores) ───────────────────────
        // Each Discord guild is its own tenant/mind on clank-mind-prod +
        // clank-memory-vectors-prod (memory.forTenant). This Lambda is
        // ISOLATED from Slack: no IAM for clank-mind-dev and no Slack table name
        // in its env, so a Discord request can't touch the Slack group's data
        // even by a bug. Discord has no t-shirts → no sharp layer needed.
        const PROD_TABLE = 'clank-mind-prod';
        const PROD_VECTOR_BUCKET = 'clank-memory-vectors-prod';
        const PROD_VECTOR_INDEX = 'clank-memory';

        const discordPermissions = [
            {
                // No Scan: ElectroStore reads the byTenant GSI, so a scan is dead
                // code here — and it would let one bug enumerate EVERY tenant's
                // rows plus every METER# wallet, defeating the key prefixing.
                actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
                resources: [
                    `arn:aws:dynamodb:${REGION}:*:table/${PROD_TABLE}`,
                    `arn:aws:dynamodb:${REGION}:*:table/${PROD_TABLE}/index/*`,
                ],
            },
            {
                actions: [
                    's3vectors:PutVectors',
                    's3vectors:QueryVectors',
                    's3vectors:GetVectors',
                    's3vectors:DeleteVectors',
                    's3vectors:ListVectors',
                ],
                resources: [
                    `arn:aws:s3vectors:${REGION}:*:bucket/${PROD_VECTOR_BUCKET}`,
                    `arn:aws:s3vectors:${REGION}:*:bucket/${PROD_VECTOR_BUCKET}/index/*`,
                ],
            },
            {
                actions: ['s3:PutObject', 's3:GetObject'],
                resources: [`arn:aws:s3:::${IMAGES_BUCKET}/*`],
            },
        ];

        const discordProcessor = new sst.aws.Function('DiscordProcessor', {
            handler: 'src/handlers/discord/processor.processDiscord',
            runtime: 'nodejs22.x',
            timeout: '300 seconds',
            memory: '1024 MB',
            environment: {
                // Discord is a SEPARATE OpenRouter account (its own billing +
                // Auto Recharge funded by Discord revenue). Falls back to the
                // main key until DISCORD_OPENROUTER_API_KEY is set, so nothing
                // breaks before the second account exists. All Discord generation
                // (think + image + embeddings + reflection) bills to this key,
                // because this Lambda's env is separate from Slack's.
                OPENROUTER_API_KEY: process.env.DISCORD_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '',
                S3_BUCKET_NAME: IMAGES_BUCKET,
                VECTOR_DUAL_WRITE: process.env.VECTOR_DUAL_WRITE || 'true',
                PROD_DYNAMODB_TABLE_NAME: PROD_TABLE,
                PROD_VECTOR_BUCKET,
                PROD_VECTOR_INDEX,
                DISCORD_APP_ID: process.env.DISCORD_APP_ID || '',
                DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '',
            },
            permissions: discordPermissions,
        });

        // ── iMessage API (Function URL — sync long calls) ────────────────────
        // One Lambda, three POST paths (/auth, /generate, /commit). A Function
        // URL instead of an API Gateway route because /generate runs the full
        // pipeline SYNCHRONOUSLY (30-120s) and API Gateway hard-caps
        // integrations at 29s. Same prod-only IAM as Discord: an iMessage
        // request cannot touch the Slack group's data even by a bug. Bills the
        // business OpenRouter account (same fallback chain as Discord).
        const imessageApi = new sst.aws.Function('ImessageApi', {
            handler: 'src/handlers/imessage/api.handleImessage',
            runtime: 'nodejs22.x',
            timeout: '300 seconds',
            memory: '1024 MB',
            url: true,
            environment: {
                OPENROUTER_API_KEY: process.env.DISCORD_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '',
                S3_BUCKET_NAME: IMAGES_BUCKET,
                VECTOR_DUAL_WRITE: process.env.VECTOR_DUAL_WRITE || 'true',
                PROD_DYNAMODB_TABLE_NAME: PROD_TABLE,
                PROD_VECTOR_BUCKET,
                PROD_VECTOR_INDEX,
                IMESSAGE_TOKEN_SECRET: process.env.IMESSAGE_TOKEN_SECRET || '',
                // Dev-auth gate for the simulator demo — REMOVE before launch.
                IMESSAGE_DEV_KEY: process.env.IMESSAGE_DEV_KEY || '',
                // Explicit opt-in for simulator dev auth — OFF unless '1'. A
                // launched deployment leaves this unset (dev branch = dead code).
                IMESSAGE_DEV_AUTH: process.env.IMESSAGE_DEV_AUTH || '',
                IMESSAGE_BUNDLE_IDS:
                    process.env.IMESSAGE_BUNDLE_IDS || 'com.example.clank,com.example.clank.MessagesExt',
            },
            permissions: discordPermissions,
        });

        // The three Slack ROUTE lambdas only verify a signature and async-invoke
        // the processor — they never touch DynamoDB, S3 Vectors, or S3. So they
        // get neither the data IAM nor the unrelated secrets (notably the
        // billable Printify key); least privilege keeps a webhook-facing Lambda
        // from being a path to Clank's mind.
        // ── Alerting ────────────────────────────────────────────────────────
        // Clank is a paid public product now: a broken processor means users pay
        // (or spend free renders) and get nothing, and a failing Discord endpoint
        // gets DISABLED by Discord if it keeps 5xx-ing. Nothing was watching any
        // of that. Email is deliberate over anything fancier — it reaches a phone
        // at 2am with no extra service to maintain.
        const ALERT_EMAIL = process.env.ALERT_EMAIL || 'mdunn888@gmail.com';
        const alerts = new aws.sns.Topic('Alerts', { name: `clank-${stage}-alerts` });
        new aws.sns.TopicSubscription('AlertsEmail', {
            topic: alerts.arn,
            protocol: 'email',
            endpoint: ALERT_EMAIL,
        });

        // Any error at all is worth knowing about at this volume — these are
        // low-traffic functions, so threshold 1 over 5 minutes is signal, not noise.
        const lambdaErrorAlarm = (name: string, fn: sst.aws.Function, description: string) =>
            new aws.cloudwatch.MetricAlarm(`${name}Errors`, {
                name: `clank-${stage}-${name}-errors`,
                alarmDescription: description,
                namespace: 'AWS/Lambda',
                metricName: 'Errors',
                dimensions: { FunctionName: fn.name },
                statistic: 'Sum',
                period: 300,
                evaluationPeriods: 1,
                threshold: 1,
                comparisonOperator: 'GreaterThanOrEqualToThreshold',
                treatMissingData: 'notBreaching', // no traffic != broken
                alarmActions: [alerts.arn],
                okActions: [alerts.arn], // tell us when it recovers too
            });

        lambdaErrorAlarm('discord-processor', discordProcessor, 'Discord renders are failing (paid users affected).');
        lambdaErrorAlarm('slack-processor', processor, 'Slack renders are failing.');

        // Async invokes retry twice by DEFAULT. Neither processor is idempotent,
        // so a timeout (or any thrown error) would re-run the whole flow:
        // generate again, charge again, post again. Turn retries off.
        for (const [name, fn] of [
            ['ProcessorNoRetry', processor],
            ['DiscordProcessorNoRetry', discordProcessor],
        ] as const) {
            new aws.lambda.FunctionEventInvokeConfig(name, {
                functionName: fn.name,
                maximumRetryAttempts: 0,
            });
        }

        const apiEnv = {
            SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET || '',
            SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
            IMAGE_PROCESSOR_FUNCTION_NAME: processor.name,
        };
        const apiPermissions = [{ actions: ['lambda:InvokeFunction'], resources: [processor.arn] }];

        // REST API (Slack uses API Gateway v1) + custom domain.
        const api = new sst.aws.ApiGatewayV1('Api', { domain: { name: DOMAIN, cert: CERT_ARN } });
        const routeArgs = {
            runtime: 'nodejs22.x' as const,
            timeout: '30 seconds' as const,
            environment: apiEnv,
            permissions: apiPermissions,
        };
        api.route('POST /slack/image', { handler: 'src/handlers/slack/slashCommand.slackImageCommand', ...routeArgs });
        api.route('POST /slack/interactions', {
            handler: 'src/handlers/slack/interactions.handleInteraction',
            ...routeArgs,
        });
        api.route('POST /slack/events', {
            handler: 'src/handlers/slack/events.handleEvent',
            ...routeArgs,
            timeout: '10 seconds',
        });
        // Discord interactions endpoint: verify Ed25519, ack the PING, defer the
        // /clank slash command + async-invoke the Discord processor. Only needs
        // the public key (verify) + the processor name (invoke) — no data access.
        api.route('POST /discord/interactions', {
            handler: 'src/handlers/discord/interactions.handleDiscordInteraction',
            runtime: 'nodejs22.x',
            timeout: '10 seconds',
            environment: {
                DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY || '',
                DISCORD_PROCESSOR_FUNCTION_NAME: discordProcessor.name,
            },
            permissions: [{ actions: ['lambda:InvokeFunction'], resources: [discordProcessor.arn] }],
        });
        // Discord webhook events (entitlement lifecycle). Grants a purchase the
        // moment it happens, and — the reason this exists — catches
        // ENTITLEMENT_DELETE (refund/chargeback) so we can claw back unspent
        // credits instead of eating the reversal blind. Needs the prod-table
        // wallet ops only; no vectors, no images, no Slack.
        api.route('POST /discord/webhook', {
            handler: 'src/handlers/discord/webhook.handleDiscordWebhook',
            runtime: 'nodejs22.x',
            timeout: '10 seconds',
            environment: {
                DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY || '',
                DISCORD_APP_ID: process.env.DISCORD_APP_ID || '',
                DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '',
                PROD_DYNAMODB_TABLE_NAME: PROD_TABLE,
            },
            permissions: [
                {
                    actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
                    resources: [`arn:aws:dynamodb:${REGION}:*:table/${PROD_TABLE}`],
                },
            ],
        });
        api.deploy();

        // 5xx on the API covers every webhook endpoint at once. This one matters
        // most: Discord DISABLES an interactions/webhook endpoint that keeps
        // failing, and Slack de-registers too — so a quiet 5xx streak doesn't
        // just break requests, it can unregister the app.
        new aws.cloudwatch.MetricAlarm('Api5xxErrors', {
            name: `clank-${stage}-api-5xx`,
            alarmDescription: 'API Gateway is returning 5xx — Discord/Slack may disable the endpoint.',
            namespace: 'AWS/ApiGateway',
            metricName: '5XXError',
            dimensions: { ApiName: api.nodes.api.name, Stage: stage },
            statistic: 'Sum',
            period: 300,
            evaluationPeriods: 1,
            threshold: 1,
            comparisonOperator: 'GreaterThanOrEqualToThreshold',
            treatMissingData: 'notBreaching',
            alarmActions: [alerts.arn],
            okActions: [alerts.arn],
        });

        return {
            api: api.url,
            processor: processor.name,
            discordProcessor: discordProcessor.name,
            discordEndpoint: $interpolate`${api.url}/discord/interactions`,
            discordWebhookEndpoint: $interpolate`${api.url}/discord/webhook`,
            imessageApi: imessageApi.url,
        };
    },
});
