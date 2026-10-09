import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importJsonFile } from '../src/mysql-store.js';

async function inspect(value) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ss-import-'));
  const file = path.join(dir, 'data.json');
  await writeFile(file, JSON.stringify(value));
  const groups = [];
  try {
    const summary = await importJsonFile(file,
      async (name, kind, position) => {
        const group = { name, kind, position, records: [] };
        groups.push(group);
        return group;
      }, async (group, body) => group.records.push(JSON.parse(body)));
    return { summary, groups };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('importador preserva listas, objetos, escalares, grupos vazios e ordem', async () => {
  const result = await inspect({ produtos: [{ id: 1, nome: 'A' }, { id: 2, tags: ['x'] }],
    configuracao: { moeda: 'BRL' }, ativo: false, vazio: [], nulo: null, '': 7, ' a ': 'texto' });
  assert.deepEqual(result.summary, { collections: 7, records: 7, rootType: 'object' });
  assert.deepEqual(result.groups.map(g => [g.name, g.kind, g.position]), [
    ['produtos', 'list', 1], ['configuracao', 'single', 2], ['ativo', 'single', 3],
    ['vazio', 'list', 4], ['nulo', 'single', 5], ['', 'single', 6], [' a ', 'single', 7],
  ]);
  assert.deepEqual(result.groups.map(g => g.records), [
    [{ id: 1, nome: 'A' }, { id: 2, tags: ['x'] }], [{ moeda: 'BRL' }], [false], [], [null], [7], ['texto'],
  ]);
  const array = await inspect([{ id: 1 }, [2, 3]]);
  assert.deepEqual(array.summary, { collections: 1, records: 2, rootType: 'array' });
  assert.deepEqual(array.groups[0].records, [{ id: 1 }, [2, 3]]);
  const scalar = await inspect('texto');
  assert.deepEqual(scalar.summary, { collections: 1, records: 1, rootType: 'scalar' });
  assert.deepEqual(scalar.groups[0].records, ['texto']);
});

test('importador aceita item JSON maior que 16 MB', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ss-import-large-'));
  const file = path.join(dir, 'data.json');
  try {
    await writeFile(file, JSON.stringify({ item: 'x'.repeat(16 * 1024 * 1024) }));
    let recordBytes = 0;
    const result = await importJsonFile(file, async name => name, async (_group, body) => { recordBytes = Buffer.byteLength(body); });
    assert.equal(result.records, 1);
    assert.ok(recordBytes > 16 * 1024 * 1024);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
