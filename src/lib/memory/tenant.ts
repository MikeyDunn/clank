// ─── Tenant scoping ──────────────────────────────────────────────
// Clank is going multi-tenant: one production store holds many independent
// "minds", one per tenant. A tenant id is '<platform>:<id>':
//   • 'slack:T012345'   — the original group's Clank (migrated in later)
//   • 'discord:G987654' — a Discord server's blank-slate Clank
//
// Isolation is by key prefix (DynamoDB) + metadata filter (S3 Vectors), funneled
// through these helpers so a query can't silently forget its tenant. STRICTLY
// BACKWARD-COMPATIBLE: a null/empty tenant returns everything unchanged — the
// exact single-tenant Slack Clank as it is today — so nothing changes for the
// live path until a tenant is actually threaded through.

export type Tenant = string | null | undefined;

/**
 * Scope a partition value (pk or gsi1pk) to a tenant. Untenanted → unchanged, so
 * the Slack Clank's existing `META` / `HIST#<uuid>` / `USER#<uid>` keys are
 * byte-identical until it's migrated in as tenant 'slack:<team>'.
 */
export function scopeKey(tenant: Tenant, base: string): string {
    return tenant ? `TENANT#${tenant}#${base}` : base;
}

/** The `begins_with` prefix for a tenant's items of a given base type (for scans/queries). */
export function scopePrefix(tenant: Tenant, base: string): string {
    return tenant ? `TENANT#${tenant}#${base}` : base;
}

/** Metadata filter for tenant-scoped S3 Vectors queries — empty when untenanted. */
export function tenantFilter(tenant: Tenant): Record<string, string> {
    return tenant ? { tenant } : {};
}

/** Build a tenant id from a platform + native id. */
export function tenantId(platform: 'slack' | 'discord' | 'imessage', id: string): string {
    return `${platform}:${id}`;
}
