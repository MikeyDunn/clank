// Tests for tenant.js — the multi-tenant scoping helpers. The critical property
// is backward-compatibility: an untenanted call must be byte-identical to the
// single-tenant Slack Clank's current keys, so nothing changes until a tenant is
// threaded through.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scopeKey, scopePrefix, tenantFilter, tenantId } from '../src/lib/memory/tenant.js';

test('scopeKey: untenanted keys are UNCHANGED (Slack Clank as-is)', () => {
    assert.equal(scopeKey(null, 'META'), 'META');
    assert.equal(scopeKey(undefined, 'HIST#abc'), 'HIST#abc');
    assert.equal(scopeKey('', 'USER#U1'), 'USER#U1');
});

test('scopeKey: tenanted keys get the TENANT prefix', () => {
    assert.equal(scopeKey('discord:G9', 'META'), 'TENANT#discord:G9#META');
    assert.equal(scopeKey('slack:T1', 'HIST#abc'), 'TENANT#slack:T1#HIST#abc');
});

test('scopePrefix: matches scopeKey so begins_with queries line up', () => {
    assert.equal(scopePrefix('discord:G9', 'USER#'), 'TENANT#discord:G9#USER#');
    assert.equal(scopePrefix(null, 'USER#'), 'USER#');
});

test('tenantFilter: empty when untenanted, {tenant} otherwise', () => {
    assert.deepEqual(tenantFilter(null), {});
    assert.deepEqual(tenantFilter('discord:G9'), { tenant: 'discord:G9' });
});

test('tenantId: composes platform:id', () => {
    assert.equal(tenantId('slack', 'T012345'), 'slack:T012345');
    assert.equal(tenantId('discord', 'G987654'), 'discord:G987654');
});
