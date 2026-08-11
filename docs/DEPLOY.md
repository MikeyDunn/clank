# Deploying Clank

Clank runs on AWS Lambda via [SST](https://sst.dev). The **stateful stores
(DynamoDB + S3 Vectors) are referenced by name + IAM, never created by SST** — so
no deploy can ever touch the data. You create those once, out of band.

## Prerequisites
- Node 22, an AWS account, and a profile in `~/.aws/config`.
- An OpenRouter API key (reasoning + image + embeddings).
- Slack and/or Discord apps (optional per platform).

## Local deploy
```bash
npm install
cp .env.example .env          # fill in keys + your deploy identifiers
npm run check                 # lint + typecheck + test
npm run deploy:dev            # sst deploy --stage dev
npm run deploy:site           # deploy the marketing site (clank.fyi)
```
The stores named in `.env` (`DYNAMODB_TABLE_NAME`, `PROD_*`) must exist first —
create the DynamoDB tables (single-table, `pk`/`sk` + a `gsi1`) and the S3 Vectors
buckets (1536-dim cosine) in your account, then point the env at them.

## CI/CD (GitHub Actions)
- **`ci.yml`** runs `npm run check` + a gitleaks secret scan on every push/PR. No
  credentials needed.
- **`deploy.yml`** is a *manual* (`workflow_dispatch`) deploy, gated on a
  `production` environment, authenticating to AWS via **OIDC** (no long-lived
  keys). It never runs on push, so a fork or PR can't deploy to your account.

### One-time OIDC setup
1. **AWS**: add GitHub as an OIDC identity provider
   (`token.actions.githubusercontent.com`) and create a deploy IAM role that
   trusts your repo, scoped to the resources SST manages.
2. **GitHub → Settings → Environments → `production`**: add required reviewers
   (the human approval gate), then add:
   - Secret `AWS_DEPLOY_ROLE_ARN` (the role from step 1) + the app secrets
     (`OPENROUTER_API_KEY`, `SLACK_*`, `DISCORD_*`, `IMESSAGE_TOKEN_SECRET`, …).
   - Variables `API_BASE_DOMAIN`, `ACM_CERT_ARN`, `SHARP_LAYER_ARN`.
3. Run **Actions → Deploy → Run workflow**, pick the stage.

Deploy stays manual by design: a public repo should never hold credentials that
auto-deploy to live infra.
