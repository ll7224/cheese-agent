import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVectorStore } from '../src/rag/sqlite-store.js';
import { DIMS } from '../src/rag/embedder.js';

function createDummyVec(firstVal: number): number[] {
  const vec = new Array(DIMS).fill(0);
  vec[0] = firstVal;
  return vec;
}

test('SqliteVectorStore supports multi-collection isolation, joint retrieval, and lifecycle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-rag-test-'));
  const dbPath = join(dir, 'test-rag.db');

  try {
    const store = new SqliteVectorStore(dbPath);

    // 1. Add chunks to distinct collections
    store.add(
      { id: 'tech-1', text: 'TypeScript interface guidelines', source: 'ts.md', index: 0, tokenEstimate: 10 },
      createDummyVec(1),
      'tech'
    );
    store.add(
      { id: 'tech-2', text: 'Rust ownership and borrowing', source: 'rust.md', index: 1, tokenEstimate: 10 },
      createDummyVec(0.9),
      'tech'
    );
    store.add(
      { id: 'legal-1', text: 'Confidentiality agreement clause', source: 'nda.md', index: 0, tokenEstimate: 10 },
      createDummyVec(0.1),
      'legal'
    );
    store.add(
      { id: 'default-1', text: 'General company introduction', source: 'about.md', index: 0, tokenEstimate: 10 },
      createDummyVec(0.5)
      // default collection
    );

    // 2. Test size and collection counting
    assert.equal(store.size(), 4);
    assert.equal(store.size('tech'), 2);
    assert.equal(store.size('legal'), 1);
    assert.equal(store.size('default'), 1);
    assert.equal(store.size(['tech', 'legal']), 3);

    const cols = store.getCollections();
    assert.equal(cols.length, 3);
    assert.equal(cols.find(c => c.id === 'tech')?.count, 2);

    // 3. Test sources filtering
    assert.deepEqual(store.sources('tech').sort(), ['rust.md', 'ts.md']);
    assert.deepEqual(store.sources('legal'), ['nda.md']);

    // 4. Test vectorSearch with collection filtering
    const searchVec = createDummyVec(1);
    const techOnly = store.vectorSearch(searchVec, 5, ['tech']);
    assert.equal(techOnly.length, 2);
    assert.ok(techOnly.every(r => r.chunk.collectionId === 'tech'));

    const legalOnly = store.vectorSearch(searchVec, 5, ['legal']);
    assert.equal(legalOnly.length, 1);
    assert.equal(legalOnly[0].chunk.id, 'legal-1');

    const multiCol = store.vectorSearch(searchVec, 5, ['tech', 'legal']);
    assert.equal(multiCol.length, 3);

    const emptyFilter = store.vectorSearch(searchVec, 5, []);
    assert.equal(emptyFilter.length, 0);

    // 5. Test keywordSearch with collection filtering
    const kwTech = store.keywordSearch('guidelines', 5, ['tech']);
    assert.equal(kwTech.length, 1);
    assert.equal(kwTech[0].chunk.id, 'tech-1');

    const kwLegal = store.keywordSearch('guidelines', 5, ['legal']);
    assert.equal(kwLegal.length, 0);

    // 6. Test deleteCollection lifecycle
    store.clear('legal');
    assert.equal(store.size('legal'), 0);
    assert.equal(store.size('tech'), 2);
    assert.equal(store.size(), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
