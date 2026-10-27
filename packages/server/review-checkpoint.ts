/** Durable local-review snapshots. Browser state stays beside the owner's checkpoint. */
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { ReviewProgressSnapshot } from '@plannotator/shared/review-progress';
import type { DiffType, GitContext } from './vcs';

export interface ReviewCheckpoint {
  v: 1;
  id: string;
  payload: Record<string, unknown> & {
    rawPatch: string;
    gitRef: string;
    snapshotId: string;
    diffType: DiffType;
    base: string;
    gitContext: GitContext;
    hideWhitespace: boolean;
  };
  fileIdentities?: Record<string, string>;
  progress: ReviewProgressSnapshot | null;
  viewedState: { viewedFiles: string[]; suppressedFiles: string[] };
  files: Record<string, { oldContent: string | null; newContent: string | null }>;
}

export function reviewCheckpointStore() {
  const path = process.env.PLANNOTATOR_REVIEW_CHECKPOINT;
  const id = process.env.PLANNOTATOR_REVIEW_ID;
  if (!path && !id) return null;
  if (!path || !isAbsolute(path) || !id || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid durable review identity');
  const directory = dirname(path);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Review checkpoint directory must be private and owned by this user');
  const read = (file: string): any => {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 64 * 1024 * 1024) throw new Error('Unsafe review checkpoint file');
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const write = (file: string, value: unknown) => {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } finally { try { unlinkSync(temporary); } catch {} }
  };
  const saved = read(path) as ReviewCheckpoint | null;
  if (saved && (saved.v !== 1 || saved.id !== id || typeof saved.payload?.rawPatch !== 'string' || typeof saved.payload?.snapshotId !== 'string' || typeof saved.payload?.gitRef !== 'string' || typeof saved.payload?.base !== 'string' || typeof saved.payload?.diffType !== 'string' || !saved.payload?.gitContext || !saved.files || typeof saved.files !== 'object' || !Array.isArray(saved.viewedState?.viewedFiles) || !Array.isArray(saved.viewedState?.suppressedFiles))) throw new Error('Invalid review checkpoint');
  return {
    id, saved,
    save(value: Omit<ReviewCheckpoint, 'v' | 'id'>) {
      const record = { v: 1, id, ...value };
      if (Buffer.byteLength(JSON.stringify(record)) > 64 * 1024 * 1024) throw new Error('Review checkpoint exceeds 64 MiB; keep the review running');
      write(path, record);
    },
    clear() { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } },
    drafts() { return read(join(directory, 'composer-drafts.json')) ?? { drafts: {}, revision: 0 }; },
    saveDrafts(drafts: unknown, revision: number) { write(join(directory, 'composer-drafts.json'), { drafts, revision }); },
    lastActivity() { return Number(read(join(directory, 'activity.json'))?.last_activity_at) || 0; },
    activity() { write(join(directory, 'activity.json'), { last_activity_at: Date.now() / 1000 }); },
  };
}
