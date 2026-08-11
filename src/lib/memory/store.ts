// ─── MindStore: the data-access seam ─────────────────────────────
// The memory LOGIC (context building, reflection, remember) is platform- and
// tenant-neutral — only the physical data access differs. That difference lives
// behind this interface, so one shared brain serves every tenant:
//
//   • LegacyStore  → the current hand-rolled db.ts on `clank-mind-dev`,
//                    UNTENANTED. The live Slack Clank, byte-identical.
//   • ElectroStore → ElectroDB on the prod table, tenant-scoped. Discord now;
//                    migrated-Slack later.
//
// Stores present a LOGICAL, single-tenant view: returned items use un-prefixed
// keys (`pk: 'USER#<uid>'`), and the tenant prefix is a physical detail the
// store owns and hides. So the memory logic never sees a tenant — it just asks
// its store, and isolation is guaranteed at the seam.

/** A stored history row (attributes as the memory logic reads them). */
export type HistoryRow = Record<string, any>;
/** A profile row; carries a logical `pk: 'USER#<uid>'` for the existing readers. */
export type ProfileRow = Record<string, any>;
/** The META/IDENTITY row: coreIdentity, reflectionCount, lastReflectedAt, commitments. */
export type IdentityRow = Record<string, any> | null;

export interface ProfileTouch {
    now: string;
    handle: string | null;
    displayName: string | null;
    incrementCount: boolean;
}

/** Per-user metering ledger. Keyed by GLOBAL Discord user id (see meterStore.ts),
 *  NOT per guild — purchases are user-owned and follow the user across servers. */
export interface UserMeter {
    freeUsedToday: number;
    freeResetDate: string | null;
    creditBalance: number;
    lastRequestAt: number | null;
    // Account name, captured ONCE at auth (SIWA gives it on first authorization
    // only). Global like the wallet — a person is one identity everywhere.
    givenName: string | null;
    familyInitial: string | null;
}

/** The wallet seam the MeteringPolicy talks to — one balance per user, global.
 *  Every mutation is a single CONDITIONAL write (see meterStore.ts): a user's
 *  concurrent requests race for real, so read-modify-write would let them bypass
 *  the cooldown, exceed the free cap, or double-spend a credit. */
export interface MeterStore {
    /** Set the account name if not already set (SIWA first-auth capture —
     *  if_not_exists, so a later auth can never overwrite the original). */
    setNameOnce(userId: string, givenName: string, familyInitial: string | null): Promise<void>;
    /** Current wallet state (for display + advisory checks). */
    getUserMeter(userId: string): Promise<UserMeter>;
    /** Atomically claim the cooldown slot. false = still cooling down. Exactly
     *  one of a user's concurrent requests can win, which serialises the rest. */
    claimCooldown(userId: string, now: number, cooldownMs: number): Promise<boolean>;
    /** Atomically spend one free render. false = today's allowance is gone. */
    consumeFree(userId: string, today: string, cap: number): Promise<boolean>;
    /** A server's free renders used today (the shared per-guild pool). */
    getServerFreeUsed(guildId: string, today: string): Promise<number>;
    /** Atomically spend one of the server's shared free renders. false = pool dry. */
    consumeServerFree(guildId: string, today: string, cap: number): Promise<boolean>;
    /** Atomically spend one credit. false = balance is zero. */
    spendCredit(userId: string): Promise<boolean>;
    /** Grant a purchase exactly once, keyed by entitlement id. false = already granted. */
    grantOnce(userId: string, entitlementId: string, amount: number): Promise<boolean>;
    /** Reverse a granted pack (refund/chargeback); returns credits actually removed. */
    clawback(userId: string, entitlementId: string, amount: number): Promise<number>;
}

export interface MindStore {
    // ── reads ──
    /** The evolving self (META/IDENTITY), or null before the first reflection. */
    getIdentity(): Promise<IdentityRow>;
    /** Recent journal entries (REFLECTION#…), newest-first, capped at `limit`. */
    getJournal(limit: number): Promise<HistoryRow[]>;
    /** Recent interactions by time (gsi1), newest-first, capped at `limit`. */
    recentHistory(limit: number): Promise<HistoryRow[]>;
    /** How many interactions landed after `since` (ISO ts) — the reflect trigger. */
    unreflectedCount(since: string): Promise<number>;
    /** Every user profile in this mind (one Query, not a whole-table scan). */
    scanProfiles(): Promise<ProfileRow[]>;

    // ── writes ──
    /** Append one interaction (HIST#…/ENTRY, dual-keyed into the byTime index). */
    putHistory(entry: Record<string, any>): Promise<void>;
    /** Upsert a person's profile: bump lastSeen, set-once handle/firstSeen, +1 count. */
    touchProfile(userId: string, opts: ProfileTouch): Promise<void>;
    /** Claim the reflection lock (conditional write on IDENTITY.lastReflectedAt).
     *  Returns true iff THIS caller won the race and should reflect. */
    claimReflectionLock(prevReflectedAt: string | null, now: string): Promise<boolean>;

    /** TOFU display-name claim: true if `name` is unclaimed in this tenant or
     *  already belongs to `userId`; false when another user owns it. Platforms
     *  with real identity (Slack) no-op to true. */
    claimName(userId: string, name: string): Promise<boolean>;
    /** Append a journal entry (REFLECTION#<ts>). */
    appendReflection(entry: Record<string, any>): Promise<void>;
    /** Replace META/IDENTITY (full overwrite, matching the legacy putItem). */
    putIdentity(fields: Record<string, any>): Promise<void>;
}
