// Tests for entities.js — the PROD, tenant-scoped ElectroDB models. The critical
// property is that the composed physical keys match tenant.ts's scopeKey EXACTLY
// (so a future Slack backfill and these writes land on the same rows), and that
// case-sensitive tenant ids ('discord:G9') survive ElectroDB's default
// lowercasing. All checks use `.params()` — pure key composition, no AWS calls.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    bindTable,
    HistoryEntity,
    IdentityEntity,
    ProfileEntity,
    ReflectionEntity,
} from '../src/lib/memory/entities.js';
import { scopeKey } from '../src/lib/memory/tenant.js';

bindTable('test-table');
const T = 'discord:G9'; // mixed-case on purpose — must NOT be lowercased

test('IdentityEntity: pk = scopeKey(tenant, META), sk = IDENTITY', () => {
    const { Key } = IdentityEntity.get({ tenant: T }).params();
    assert.equal(Key.pk, scopeKey(T, 'META'));
    assert.equal(Key.pk, 'TENANT#discord:G9#META'); // case preserved
    assert.equal(Key.sk, 'IDENTITY');
});

test('ReflectionEntity: pk = scopeKey(tenant, META), sk = REFLECTION#<ts>', () => {
    const { Key } = ReflectionEntity.get({ tenant: T, timestamp: '2026-08-03T00:00:00Z' }).params();
    assert.equal(Key.pk, scopeKey(T, 'META'));
    assert.equal(Key.sk, 'REFLECTION#2026-08-03T00:00:00Z');
});

test('ProfileEntity record key: pk = scopeKey(tenant, USER#<uid>), sk = PROFILE', () => {
    const { Key } = ProfileEntity.get({ tenant: T, userId: 'U123' }).params();
    assert.equal(Key.pk, scopeKey(T, 'USER#U123'));
    assert.equal(Key.pk, 'TENANT#discord:G9#USER#U123');
    assert.equal(Key.sk, 'PROFILE');
});

test('ProfileEntity byTenant GSI: all of a tenant in one gsi1 partition, keyed by userId', () => {
    const { Item } = ProfileEntity.put({ tenant: T, userId: 'U123' }).params();
    assert.equal(Item.gsi1pk, 'TENANT#discord:G9#USER'); // one partition per tenant
    assert.equal(Item.gsi1sk, 'U123');
});

test('HistoryEntity record key: pk = scopeKey(tenant, HIST#<uuid>), sk = ENTRY', () => {
    const { Key } = HistoryEntity.get({ tenant: T, historyId: 'abc-uuid' }).params();
    assert.equal(Key.pk, scopeKey(T, 'HIST#abc-uuid'));
    assert.equal(Key.sk, 'ENTRY');
});

test('HistoryEntity byTime GSI: per-tenant partition (reflection/recency stay isolated)', () => {
    const { Item } = HistoryEntity.put({ tenant: T, historyId: 'abc', timestamp: '2026-08-03T00:00:00Z' }).params();
    assert.equal(Item.gsi1pk, 'TENANT#discord:G9#HIST');
    assert.equal(Item.gsi1sk, '2026-08-03T00:00:00Z');
    // History's byTime partition must NOT collide with profiles' byTenant partition.
    assert.notEqual(Item.gsi1pk, 'TENANT#discord:G9#USER');
});

test('two tenants never share a partition (isolation)', () => {
    const a = IdentityEntity.get({ tenant: 'discord:G9' }).params().Key.pk;
    const b = IdentityEntity.get({ tenant: 'slack:T1' }).params().Key.pk;
    assert.notEqual(a, b);
    assert.equal(a, 'TENANT#discord:G9#META');
    assert.equal(b, 'TENANT#slack:T1#META');
});
