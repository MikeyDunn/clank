// Past-render recall: mem-id tagging (think.ts) + reference loading ids (pipeline.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.S3_BUCKET_NAME = 'imgs';
const { formatRecall } = await import('../src/lib/imageProcessor/think.js');
const { memoryRefIds } = await import('../src/lib/imageProcessor/pipeline.js');

const OWN = 'https://imgs.s3.us-east-1.amazonaws.com/a.jpeg';
const OWN2 = 'https://imgs.s3.us-east-1.amazonaws.com/b.jpeg';

test('formatRecall: tags render-backed memories with stable mem ids', () => {
    const mem = new Map<string, string>();
    const out = formatRecall(
        [
            { text: 'a definition', imageUrl: null },
            { text: 'carl at the beach', imageUrl: OWN },
            { text: 'carl again', imageUrl: OWN2 },
        ],
        mem
    );
    assert.deepEqual(out, ['a definition', '[image mem1] carl at the beach', '[image mem2] carl again']);
    // A later recall hitting the same render reuses its id.
    assert.deepEqual(formatRecall([{ text: 'carl at the beach', imageUrl: OWN }], mem), [
        '[image mem1] carl at the beach',
    ]);
    assert.equal(mem.size, 2);
});

test('formatRecall: never tags a url outside our images bucket', () => {
    const mem = new Map<string, string>();
    const out = formatRecall([{ text: 'x', imageUrl: 'https://imgs.s3.amazonaws.com.evil.com/a.jpeg' }], mem);
    assert.deepEqual(out, ['x']);
    assert.equal(mem.size, 0);
});

test('memoryRefIds: only recalled mem ids, deduped, capped at 3', () => {
    const known = { mem1: OWN, mem2: OWN2, mem3: OWN, mem4: OWN2 };
    assert.deepEqual(memoryRefIds([{ id: 'primary' }, { id: 'mem2' }, 'mem1', { id: 'mem2' }, { id: 'mem9' }], known), [
        'mem2',
        'mem1',
    ]);
    assert.deepEqual(memoryRefIds(['mem1', 'mem2', 'mem3', 'mem4'], known), ['mem1', 'mem2', 'mem3']);
    assert.deepEqual(memoryRefIds(undefined, known), []);
});
