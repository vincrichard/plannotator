import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { GUIDE_BLOCK_MAX_LINES } from '@plannotator/core/guide-blocks';
import type { CodeGuideOutput, GuideDiffRef } from '@plannotator/shared/guide';

const MAX_CONTEXT_BYTES = 1024 * 1024;
const MAX_CONTEXT_FILES = 50_000;
type FileIdentity = string;
export interface GuideContextSnapshot { root: string; files: Map<string, FileIdentity>; excerpts: Map<string, string> }
const identity = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

/** Capture identities, not repository contents; only requested excerpts are read later. */
export function captureGuideContext(cwd: string, diffType = 'uncommitted'): GuideContextSnapshot | undefined {
  try {
    const root = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    const worktree = ['uncommitted', 'unstaged', 'since-base', 'local-vs-remote'].includes(diffType);
    const index = diffType === 'staged';
    const commitRef = diffType.startsWith('commit:') ? diffType.slice(7) : 'HEAD';
    // shortcut: unsupported VCS/synthetic views need a source-version resolver before accepting repository context.
    if (!worktree && !index && !['last-commit', 'branch', 'merge-base', 'all'].includes(diffType) && !diffType.startsWith('commit:')) return undefined;
    const entries = worktree || index
      ? execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      : execFileSync('git', ['ls-tree', '-r', '-z', execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${commitRef}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const files = new Map<string, FileIdentity>();
    for (const entry of entries.split('\0')) {
      const match = /^(100644|100755) (?:blob )?([0-9a-f]+)(?: 0)?\t(.+)$/.exec(entry);
      if (!match || files.size >= MAX_CONTEXT_FILES) continue;
      const file = match[3];
      if (!worktree) { files.set(file, `blob:${match[2]}`); continue; }
      try {
        const target = resolve(root, file);
        if (realpathSync(target) !== target) continue;
        const stat = lstatSync(target);
        if (stat.isFile() && stat.size <= MAX_CONTEXT_BYTES) files.set(file, identity(stat));
      } catch { /* A missing tracked file cannot provide context. */ }
    }
    return { root, files, excerpts: new Map() };
  } catch { return undefined; }
}

export function hydrateGuideContext(guide: CodeGuideOutput, snapshot?: GuideContextSnapshot): CodeGuideOutput {
  return { ...guide, sections: guide.sections.map(section => ({ ...section, diffs: section.diffs.map(block => {
    const { source: _untrusted, ...ref } = block;
    if (ref.kind !== 'context') return ref;
    if (!snapshot || !snapshot.files.has(ref.file)) return ref;
    const range = ref.newRange;
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < 1 || range.end < range.start || range.end - range.start >= GUIDE_BLOCK_MAX_LINES) return ref;
    const key = JSON.stringify([ref.file, range.start, range.end]);
    const captured = snapshot.excerpts.get(key);
    if (captured !== undefined) return { ...ref, source: captured };
    if (isAbsolute(ref.file) || ref.file.includes('\\') || ref.file.split('/').some(part => part === '..' || part === '.' || !part)) return ref;
    const target = resolve(snapshot.root, ref.file);
    const rel = relative(snapshot.root, target);
    if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) return ref;
    let fd: number | undefined;
    try {
      const version = snapshot.files.get(ref.file)!;
      if (version.startsWith('blob:')) {
        const bytes = execFileSync('git', ['cat-file', 'blob', version.slice(5)], { cwd: snapshot.root, maxBuffer: MAX_CONTEXT_BYTES, stdio: ['ignore', 'pipe', 'ignore'] });
        if (bytes.includes(0)) return ref;
        const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n');
        if (lines.at(-1) === '') lines.pop();
        if (range.end > lines.length) return ref;
        const source = lines.slice(range.start - 1, range.end).join('\n');
        snapshot.excerpts.set(key, source);
        return { ...ref, source };
      }
      if (realpathSync(target) !== target) return ref;
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(fd);
      if (!before.isFile() || identity(before) !== snapshot.files.get(ref.file) || before.size > MAX_CONTEXT_BYTES) return ref;
      const bytes = readFileSync(fd);
      if (identity(fstatSync(fd)) !== identity(before) || bytes.includes(0)) return ref;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      if (range.end > lines.length) return ref;
      const source = lines.slice(range.start - 1, range.end).join('\n');
      snapshot.excerpts.set(key, source);
      return { ...ref, source };
    } catch { return ref; }
    finally { if (fd !== undefined) closeSync(fd); }
  }) })) };
}

export interface GuideBlockUpdate { sectionIndex: number; block: GuideDiffRef }

/** Stable IDs replace just the named block; unrelated sections and comments keep their anchors. */
export function applyGuideBlockUpdates(guide: CodeGuideOutput, updates: unknown): CodeGuideOutput {
  if (!Array.isArray(updates) || updates.length === 0 || updates.length > 200) throw new Error('updates must contain 1–200 block updates');
  const next = { ...guide, sections: guide.sections.map(section => ({ ...section, diffs: [...section.diffs] })) };
  const seen = new Set<string>();
  for (const update of updates) {
    if (!update || !Number.isSafeInteger(update.sectionIndex) || !next.sections[update.sectionIndex]
      || !update.block || typeof update.block.id !== 'string' || !update.block.id.trim()
      || typeof update.block.file !== 'string' || seen.has(update.block.id)) throw new Error('Each update needs a valid sectionIndex and unique block.id and block.file');
    seen.add(update.block.id);
    const existingSection = next.sections.findIndex(section => section.diffs.some(block => block.id === update.block.id));
    if (existingSection !== -1 && existingSection !== update.sectionIndex) throw new Error(`Block ${update.block.id} belongs to section ${existingSection}; update it there`);
    const blocks = next.sections[update.sectionIndex].diffs;
    const index = blocks.findIndex(block => block.id === update.block.id);
    if (index < 0) blocks.push({ ...update.block });
    else blocks[index] = { ...update.block };
  }
  return next;
}

export function guideBlockRepairPrompt(guide: CodeGuideOutput, issues: unknown): string {
  return [
    'Repair only the listed coverage or block problems in this guide. Return JSON {"updates":[{"sectionIndex":0,"block":{"id":"stable-block-id","file":"path","summary":"Explanation","kind":"diff","oldRange":{"start":1,"end":10},"newRange":{"start":1,"end":10}}}]} .',
    'Replace an existing block by its id in the same section, or add a new id. Keep all other blocks unchanged. Split blocks exceeding 250 displayed lines into meaningful responsibilities. Include all uncovered added and deleted lines. Context excerpts must be tracked repository files unchanged since generation began; omit unverifiable context by replacing that block with a diff block. Never supply source text; the server captures it.',
    'Coverage feedback:', JSON.stringify(issues), 'Current guide:', JSON.stringify(guide),
  ].join('\n');
}
