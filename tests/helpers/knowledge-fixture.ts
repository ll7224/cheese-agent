import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import { DIMS } from '../../src/rag/embedder.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';
import { chunkWithSpans } from '../../src/knowledge/chunks.js';
import type { KnowledgeContext, Library, Source } from '../../src/knowledge/types.js';

export function createMockEmbedder(fixedDimValue: number = 0.1) {
  return async (texts: string[]): Promise<number[][]> => {
    return texts.map((text) => {
      const vec = new Array(DIMS).fill(0);
      let sum = 0;
      for (let i = 0; i < text.length; i++) {
        sum += text.charCodeAt(i);
      }
      vec[0] = ((sum % 100) / 100) + fixedDimValue;
      return vec;
    });
  };
}

export interface TestFixtureEnv {
  tempDir: string;
  store: KnowledgeStore;
  cleanup: () => void;
}

export function createKnowledgeTestEnv(t?: TestContext): TestFixtureEnv {
  const tempDir = mkdtempSync(join(tmpdir(), 'cheese-knowledge-test-'));
  const dbPath = join(tempDir, 'knowledge-center.db');
  const store = new KnowledgeStore(dbPath);

  const cleanup = () => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  };

  if (t) {
    t.after(() => cleanup());
  }

  return { tempDir, store, cleanup };
}

export function seedDocument(
  store: KnowledgeStore,
  libraryId: string,
  docPath: string,
  content: string,
  embedFn?: (texts: string[]) => Promise<number[][]>
) {
  const sourceId = `src-${libraryId}-${docPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
  let source = store.getSource(sourceId);
  if (!source) {
    source = store.createSource({
      id: sourceId,
      libraryId,
      kind: 'managed',
      locator: docPath,
      enabled: true,
    });
  }

  const chunks = chunkWithSpans(content);
  const hash = createHash('sha256').update(content).digest('hex');

  const chunkDrafts = chunks.map((c) => ({
    text: c.text,
    span: c.span,
    embedding: embedFn ? new Array(DIMS).fill(0.1) : undefined,
  }));

  return store.publishRevision({
    sourceId: source.id,
    sourceKey: docPath,
    content,
    hash,
    expectedPreviousRevisionId: null,
    chunks: chunkDrafts,
  });
}
