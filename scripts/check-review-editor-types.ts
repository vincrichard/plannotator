import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// shortcut: existing review-editor errors are baselined; remove this gate once plain tsc passes.
export function normalizeDiagnostics(output: string, root: string): string[] {
  const normalized = output.replaceAll('\\', '/')
    .replaceAll(`${root.replaceAll('\\', '/').replace(/\/$/, '')}/`, '')
    .replace(/node_modules\/\.bun\/[^/]+\/node_modules\//g, 'node_modules/');
  const diagnostics: string[] = [];
  for (const line of normalized.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const header = /^(?:(.+)\(\d+,\d+\): )?error TS(\d+): (.*)$/.exec(line);
    if (header) diagnostics.push(`${header[1] ?? '<compiler>'}: TS${header[2]}: ${header[3]}`);
    else if (/^\s/.test(line) && diagnostics.length) diagnostics[diagnostics.length - 1] += `\n${line.trim()}`;
    else throw new Error(`Unexpected compiler output: ${line}`);
  }
  return diagnostics.sort();
}

export function checkCompilerResult(exitCode: number | null, output: string, root: string, baseline: string[]) {
  const actual = normalizeDiagnostics(output, root);
  if ((exitCode !== 0 && exitCode !== 2) || (exitCode !== 0 && !actual.length)) {
    throw new Error(`TypeScript failed without a completed type check (exit ${exitCode}).\n${output}`);
  }
  const stale = [...baseline];
  const added: string[] = [];
  for (const diagnostic of actual) {
    const index = stale.indexOf(diagnostic);
    if (index === -1) added.push(diagnostic);
    else stale.splice(index, 1);
  }
  return { added, stale };
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, '..');
    const require = createRequire(resolve(root, 'apps/review/package.json'));
    const compiler = require.resolve('typescript/bin/tsc');
    const result = Bun.spawnSync([
      process.execPath, compiler, '--noEmit', '--pretty', 'false',
      '-p', 'packages/review-editor/tsconfig.json',
      '--typeRoots', 'packages/ui/node_modules/@types,node_modules/@types',
    ], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const baseline: unknown = JSON.parse(readFileSync(resolve(import.meta.dir, 'review-editor-types.baseline.json'), 'utf8'));
    if (!Array.isArray(baseline) || baseline.some(entry => typeof entry !== 'string')) {
      throw new Error('The review-editor type baseline must be an array of diagnostic strings.');
    }
    const { added, stale } = checkCompilerResult(result.exitCode,
      result.stdout.toString() + result.stderr.toString(), root, baseline);
    if (added.length || stale.length) {
      if (added.length) console.error(`New review-editor type errors (fix these):\n${added.join('\n\n')}`);
      if (stale.length) console.error(`Resolved type errors (remove these entries from scripts/review-editor-types.baseline.json):\n${stale.join('\n\n')}`);
      process.exitCode = 1;
    } else {
      console.log(`Review-editor type check: no new errors (${baseline.length} existing diagnostics).`);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
