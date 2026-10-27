import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewCheckpointStore } from './review-checkpoint';

test('checkpoint state refuses unsafe files and keeps durable draft revisions private', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-checkpoint-store-'));
  const originalPath = process.env.PLANNOTATOR_REVIEW_CHECKPOINT;
  const originalId = process.env.PLANNOTATOR_REVIEW_ID;
  try {
    const path = join(root, 'checkpoint.json');
    process.env.PLANNOTATOR_REVIEW_CHECKPOINT = path;
    process.env.PLANNOTATOR_REVIEW_ID = 'b'.repeat(32);
    const store = reviewCheckpointStore()!;
    expect(store.saved).toBeNull();
    store.saveDrafts({ lines: ['unfinished'] }, 1);
    expect(reviewCheckpointStore()!.drafts()).toEqual({ drafts: { lines: ['unfinished'] }, revision: 1 });
    expect(statSync(join(root, 'composer-drafts.json')).mode & 0o077).toBe(0);
    store.activity(); expect(store.lastActivity()).toBeGreaterThan(0);
    writeFileSync(path, '{broken', { mode: 0o600 });
    expect(() => reviewCheckpointStore()).toThrow();
    unlinkSync(path);
    symlinkSync(join(root, 'composer-drafts.json'), path);
    expect(() => reviewCheckpointStore()).toThrow();
    expect(JSON.parse(readFileSync(join(root, 'composer-drafts.json'), 'utf8')).revision).toBe(1);
    unlinkSync(path); chmodSync(root, 0o755);
    expect(() => reviewCheckpointStore()).toThrow();
  } finally {
    if (originalPath === undefined) delete process.env.PLANNOTATOR_REVIEW_CHECKPOINT; else process.env.PLANNOTATOR_REVIEW_CHECKPOINT = originalPath;
    if (originalId === undefined) delete process.env.PLANNOTATOR_REVIEW_ID; else process.env.PLANNOTATOR_REVIEW_ID = originalId;
    rmSync(root, { recursive: true, force: true });
  }
});
