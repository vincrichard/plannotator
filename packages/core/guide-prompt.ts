/**
 * Guided Review generation, the pure half: the organizer prompt, its JSON
 * output schema, the user message that frames the changeset, and the
 * validator that holds model output to the coverage rule. Browser-safe and
 * zero-dependency, so any host (the Plannotator servers, Pi, or an external
 * app such as Workspaces) generates guides with Plannotator's exact prompt.
 * Moved verbatim from packages/server/guide/guide-review.ts, which
 * re-exports every name; the engine plumbing (commands, output parsing,
 * sessions) stays there.
 */

import type { CodeGuideOutput, GuideDiffRef, GuideSection } from "./guide";
import { isGuideLineRange } from "./guide-blocks";
import type { DiffType } from "./diff-type";
import {
  buildWorkspacePromptContextLines,
  getLocalDiffInstruction,
  type WorkspaceReviewPromptContext,
} from "./review-prompt";

/** The PR fields buildGuideUserMessage reads. Structural, so the server's
 *  full `PRMetadata` (GitHub or GitLab) is accepted as-is. */
export interface GuidePromptPRMetadata {
  url: string;
  baseBranch: string;
  /** Carry the diff inline when there is no local checkout: set for platforms
   *  no agent-allowed CLI can read (Bitbucket), where the URL alone is not
   *  enough. Absent keeps the URL-only message. */
  inlineDiff?: boolean;
}

/** Generic structural validation failure (no sections / blank overviews).
 *  onJobComplete deliberately does NOT surface this string on the job card —
 *  the caller substitutes GUIDE_EMPTY_OUTPUT_ERROR — whereas the informative
 *  outside-changeset validation error passes through verbatim. */
export const GUIDE_NO_SECTIONS_ERROR = "No sections survived validation";

export const GUIDE_SCHEMA_JSON = JSON.stringify({
  type: "object",
  properties: {
    focused: { type: "boolean", const: true },
    title: { type: "string" },
    intent: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          overview: { type: "string" },
          diffs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                kind: { type: "string", enum: ["diff", "context"] },
                oldRange: { type: "object", properties: { start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } }, required: ["start", "end"], additionalProperties: false },
                newRange: { type: "object", properties: { start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } }, required: ["start", "end"], additionalProperties: false },
                file: { type: "string" },
                summary: { type: "string" },
              },
              required: ["id", "kind", "file", "summary"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "overview", "diffs"],
        additionalProperties: false,
      },
    },
    unplacedFiles: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["focused", "title", "intent", "sections", "unplacedFiles"],
  additionalProperties: false,
});

/**
 * The Guided Review methodology. MIRRORED VERBATIM into the standalone
 * `plannotator-guide` agent skill (github.com/plannotator/guides,
 * skills/plannotator-guide/SKILL.md, section "2. Write the guide"), where only
 * the mechanics differ (the diff is guide.patch, the output is guide.json).
 * When this text changes, update the skill in the same change: a guide made by
 * an agent must follow the same rules as one made in-app.
 */
export const GUIDE_REVIEW_PROMPT = `# Guided Review Organizer

Explain this changeset to a capable engineer who has not seen the codebase.
You are organizing a review, not hunting for bugs or producing a findings report.
Write like a colleague: plain words, short sentences, concrete behavior and reasons.
Use backticks for code names, no emoji or em-dashes, and no praise or verdicts.

## Reading order
Start with an overview of the feature's lifecycle when it has one: where it is
called, what calls it and how, the main operation, and how it ends or cleans up.
Then follow that natural execution order across files, explaining supporting
steps progressively. For example: entry point → prepare container → run task →
save results and release resources. Explain image selection and cache reuse
under preparation, rather than starting the reader with a large helper.
For changes without a lifecycle, use the most natural conceptual order.

## Structure
Return focused: true, title, intent, sections, and unplacedFiles: [].
Title: one descriptive line, based on the PR title when available.
Intent: one or two sentences explaining why the changeset exists.
Each section has a conceptual title, overview (Markdown explaining what, why,
and relevant implications), and diffs (ordered focused code blocks).
A section can cross files. A file can appear in many blocks and sections.
Supporting details start expanded; the reviewer can collapse them.

Each diffs item has:
- id: a unique stable descriptive ID, retained when repairing this block.
- kind: "diff" for changes, or "context" for unchanged repository code.
- file: exact repository-relative path, never an absolute path or an external file.
- summary: a short explanation of what this specific excerpt contributes.
- oldRange and/or newRange: inclusive {start, end} source line numbers.
  For diff blocks, select oldRange to cover deletions and newRange for additions.
  Include both when explaining a replacement. Ranges must be present in the
  supplied patch; quote other code as context instead.
  Context blocks use newRange only. The server reads and captures those exact
  lines from the same repository; do not supply source text yourself.
  Omit both ranges only for a short whole-file diff or a binary/metadata change.

## Focus and coverage (required)
Each generated block may display at most 250 code lines, counting additions,
deletions and unchanged context rows. This is a ceiling, not a target. Split a
large file into meaningful responsibilities, functions or lifecycle steps.
A 900-line addition must appear in multiple explained blocks, never one wall
of code. Repeated excerpts are allowed when useful; they share source comments.

Account for EVERY added and deleted line in diff blocks. Context blocks do not
count toward coverage. Binary changes, renames and other metadata-only changes
also need an explicit diff block. Do not hide missing changes in unplacedFiles
or rely on an automatic "Everything else" section.
The validator reports exact uncovered added/deleted ranges and oversized blocks.
Repair only the affected blocks or add missing blocks using their stable IDs;
you do not need to reproduce the entire guide. Keep unrelated blocks intact.
A guide is complete only after these reports are resolved.
The reviewer can comment and ask questions on code, including unchanged context.
Do not add comment affordances to explanations.

## Research
Read the supplied diff first. Use targeted repository lookups for entry points,
call sites and supporting definitions that clarify the story, including unchanged
files elsewhere in this repository. Avoid broad exploration unrelated to an
explanation. If a PR is supplied, read its title/body and a directly linked issue
when needed to understand the motivation. Do not search for unrelated tickets.

## Pipeline
1. Read the changeset and its authoritative changed-file list.
2. Trace the entry point and main flow, with targeted context lookups as needed.
3. Organize sections top-down and choose focused source ranges.
4. Explain each block in its section's story.
5. Verify all added/deleted lines and non-line changes are covered, every block
   is at most 250 displayed lines, and context comes from this repository.
6. Return structured JSON matching the schema.`;

export interface GuideChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

function buildChangedFilesBlock(changedFiles?: GuideChangedFile[]): string[] {
  if (!changedFiles || changedFiles.length === 0) return [];
  return [
    "",
    "Changed files (cover all added/deleted lines in this exact set; diff block paths must match verbatim, context blocks may quote other repository files):",
    ...changedFiles.map((f) => `${f.path} (+${f.additions}/-${f.deletions})`),
  ];
}

export function buildGuideUserMessage(
  patch: string,
  diffType: DiffType,
  options?: { defaultBranch?: string; hasLocalAccess?: boolean; prDiffScope?: string; workspace?: WorkspaceReviewPromptContext },
  prMetadata?: GuidePromptPRMetadata,
  changedFiles?: GuideChangedFile[],
): string {
  const changedFilesBlock = buildChangedFilesBlock(changedFiles);

  if (options?.workspace) {
    return buildWorkspaceGuideUserMessage(patch, options.workspace, changedFilesBlock);
  }

  if (prMetadata) {
    if (options?.prDiffScope === "full-stack") {
      return [
        `Full-stack guided review of ${prMetadata.url}`,
        "",
        "This is a stacked PR. The diff below shows ALL accumulated changes from the repository default branch through this PR's head (not just this PR's own layer).",
        "Organize the complete changeset into a guided review.",
        ...changedFilesBlock,
        "",
        "```diff",
        patch,
        "```",
      ].join("\n");
    }
    if (options?.hasLocalAccess) {
      return [
        prMetadata.url,
        "",
        "You are in a local worktree checked out at the PR head. The code is available locally.",
        `To see the PR changes, diff against the remote base branch: git diff origin/${prMetadata.baseBranch}...HEAD`,
        "Do NOT diff against the local `main` branch; it may be stale. Always use origin/.",
        "",
        "Organize this PR's changeset into a guided review.",
        ...changedFilesBlock,
      ].join("\n");
    }
    if (prMetadata.inlineDiff) {
      return [
        prMetadata.url,
        "",
        "Organize this PR's changeset into a guided review. The PR diff is below.",
        ...changedFilesBlock,
        "",
        "```diff",
        patch,
        "```",
      ].join("\n");
    }
    return [
      prMetadata.url,
      "",
      "Organize this PR's changeset into a guided review.",
      ...changedFilesBlock,
    ].join("\n");
  }

  const instruction = getLocalDiffInstruction(diffType, options?.defaultBranch);
  if (instruction) {
    return [
      `Organize ${instruction.target} into a guided review. ${instruction.inspect}`,
      ...changedFilesBlock,
    ].join("\n");
  }

  return [
    "Organize the following code changes into a guided review.",
    ...changedFilesBlock,
    "",
    "```diff",
    patch,
    "```",
  ].join("\n");
}

function buildWorkspaceGuideUserMessage(
  patch: string,
  workspace: WorkspaceReviewPromptContext,
  changedFilesBlock: string[],
): string {
  return [
    "Organize the local workspace changes across multiple nested VCS repositories into a guided review.",
    "",
    ...buildWorkspacePromptContextLines(workspace),
    ...changedFilesBlock,
    "",
    "```diff",
    patch,
    "```",
  ].join("\n");
}

/**
 * Coerces one raw (untrusted) section from model output into a well-typed
 * `GuideSection`, or drops it entirely. The validator downstream dereferences
 * `section.diffs.length` / `section.overview.trim()` unchecked — a malformed
 * section (wrong field types, missing fields) would otherwise throw there,
 * and for the guide provider that throw is swallowed upstream, leaving a
 * done-looking job that 404s on `/api/guide/:jobId`. Returns null for a
 * section with nothing of value (no title, no overview, no diffs).
 */
export function sanitizeGuideSection(raw: unknown): GuideSection | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const title = typeof s.title === "string" ? s.title : "";
  const overview = typeof s.overview === "string" ? s.overview : "";
  // Retain supported block coordinates only; server-captured source and stray fields never reach
  // the client. A missing/non-string/blank summary is simply omitted (the UI
  // renders nothing for it), never a reason to drop the ref or fail the guide.
  const diffs: GuideDiffRef[] = Array.isArray(s.diffs)
    ? s.diffs
        .filter((d): d is Record<string, unknown> & { file: string } => !!d && typeof d === "object" && typeof (d as Record<string, unknown>).file === "string")
        .map((d) => {
          const summary = typeof d.summary === "string" && d.summary.trim().length > 0 ? d.summary : undefined;
          return {
            file: d.file,
            ...(summary && { summary }),
            ...(typeof d.id === "string" && { id: d.id }),
            ...((d.kind === "diff" || d.kind === "context") && { kind: d.kind }),
            ...(isGuideLineRange(d.oldRange) && { oldRange: { start: d.oldRange.start, end: d.oldRange.end } }),
            ...(isGuideLineRange(d.newRange) && { newRange: { start: d.newRange.start, end: d.newRange.end } }),
          };

        })
    : [];
  if (title.trim().length === 0 && overview.trim().length === 0 && diffs.length === 0) return null;
  // Every surviving section gets a non-empty title: a diffs-only section
  // (blank title AND overview) used to render as a blank chapter with a
  // "Guide Generated" job around it — no parse failure, so no recovery flow.
  // Keeping the section (titled) beats dropping it: its files were PLACED by
  // the model, so they're not in unplacedFiles and dropping would silently
  // orphan them from the guide's coverage story.
  return { title: title.trim() ? title : "Untitled section", overview, diffs };
}

/** Sanitizes a raw sections array (see `sanitizeGuideSection`). Shared by the
 *  stream (Claude) and file (Codex) output paths and by onJobComplete's
 *  validation, so a malformed section from either engine never reaches an
 *  unchecked `.length` / `.trim()` call. */
export function sanitizeGuideSections(raw: unknown): GuideSection[] {
  if (!Array.isArray(raw)) return [];
  const out: GuideSection[] = [];
  for (const item of raw) {
    const sanitized = sanitizeGuideSection(item);
    if (sanitized) out.push(sanitized);
  }
  return out;
}

/** Sanitizes the model-provided `unplacedFiles` array to a plain string[]. */
export function sanitizeUnplacedFiles(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [];
}

/**
 * Shared validation core for guide output: sanitize the raw sections /
 * unplacedFiles, enforce the coverage rule against the CURRENT changed-file
 * set (fail-closed — a ref to a file that isn't part of the changeset is
 * dropped, not rendered as a dangling reference; a file placed twice keeps
 * only its first placement), and coerce title/intent to strings. Pure — used
 * by both onJobComplete (automatic ingestion) and submitManualOutput (manual
 * repair paste), so a malformed model or human-pasted payload is held to
 * exactly the same bar either way.
 */
export function validateGuideOutput(raw: unknown, changedFiles: string[]): { guide: CodeGuideOutput } | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Malformed guide output (not an object)" };
  }
  const output = raw as Record<string, unknown>;

  // Model source text is deliberately stripped by sanitizeGuideSections. A host
  // resolves context against its repository before coverage validation or display.
  const focused = output.focused === true || (Array.isArray(output.sections) && output.sections.some((value: unknown) => {
    if (!value || typeof value !== "object") return false;
    const section = value as Record<string, unknown>;
    return Array.isArray(section.diffs) && section.diffs.some((value: unknown) => {
      if (!value || typeof value !== "object") return false;
      const ref = value as Record<string, unknown>;
      return ref.id !== undefined || ref.kind !== undefined || ref.oldRange !== undefined || ref.newRange !== undefined;
    });
  }));
  if (focused) {
    if (!Array.isArray(output.sections)) return { error: GUIDE_NO_SECTIONS_ERROR };
    for (const section of output.sections) {
      if (!section || typeof section !== "object" || !Array.isArray(section.diffs)) return { error: "Focused sections require a diffs array." };
      for (const ref of section.diffs) {
        if (!ref || typeof ref !== "object" || typeof ref.file !== "string" || !ref.file.trim()) return { error: "Each focused block requires a repository file path." };
        if (typeof ref.id !== "string" || !ref.id.trim()) return { error: `Block in ${ref.file} needs a stable non-empty id.` };
        if (ref.kind !== undefined && ref.kind !== "diff" && ref.kind !== "context") return { error: `Invalid block kind in ${ref.file}.` };
        for (const key of ["oldRange", "newRange"]) {
          if (ref[key] !== undefined && !isGuideLineRange(ref[key])) return { error: `${ref.file}: invalid ${key}; use inclusive positive start/end lines.` };
        }
        if (ref.kind === "context" && (!ref.newRange || ref.oldRange)) return { error: `Context block ${ref.id} requires newRange only.` };
      }
    }
    const sections = sanitizeGuideSections(output.sections);
    if (!sections.length) return { error: GUIDE_NO_SECTIONS_ERROR };
    return { guide: {
      focused: true,
      title: typeof output.title === "string" && output.title.trim() ? output.title : "Guided review",
      intent: typeof output.intent === "string" ? output.intent : "",
      sections,
    } };
  }

  const changedSet = new Set(changedFiles);
  const placed = new Set<string>();
  const validatedSections: GuideSection[] = [];
  const sanitizedSections = sanitizeGuideSections(output.sections);
  // Files the model referenced that are not part of the changeset — tracked
  // so a fully-invalidated guide can explain WHY nothing survived (typically
  // the model guided a different commit than the one under review).
  const outsideChangeset = new Set<string>();

  for (const section of sanitizedSections) {
    const originalDiffCount = section.diffs.length;
    const diffs: GuideDiffRef[] = [];
    for (const ref of section.diffs) {
      if (!changedSet.has(ref.file)) {
        // not a real changed file
        outsideChangeset.add(ref.file);
        continue;
      }
      if (placed.has(ref.file)) continue; // duplicate — first placement wins
      placed.add(ref.file);
      diffs.push(ref);
    }

    if (diffs.length === 0) {
      // Keep a zero-diff section ONLY if it was already zero-diff in the
      // model's output (a deliberate prose-only context section) AND has
      // real overview text. A section that LOST all its diffs to
      // validation above is dropped, not kept empty.
      if (originalDiffCount === 0 && section.overview.trim().length > 0) {
        validatedSections.push({ ...section, diffs });
      }
      continue;
    }

    validatedSections.push({ ...section, diffs });
  }

  if (validatedSections.length === 0) {
    // Nothing survived validation — a guide screen with zero sections is
    // useless (it would just be a single "Everything else" bucket for the
    // whole diff). Fail closed, same as an unparseable output. When the
    // sections died because their refs named files outside the changeset,
    // say so — that failure is actionable (guide the right commit), unlike
    // genuinely structural emptiness (no sections / blank overviews), which
    // keeps the generic message.
    if (outsideChangeset.size > 0) {
      const examples = [...outsideChangeset].slice(0, 3).join(", ");
      return {
        error:
          `Guide referenced ${outsideChangeset.size} file(s) outside the changeset under review ` +
          `(e.g. ${examples}). To guide a different commit, open it in the Commits panel first, then relaunch.`,
      };
    }
    return { error: GUIDE_NO_SECTIONS_ERROR };
  }

  // unplacedFiles = every changed file that never landed in a section,
  // merged with any model-provided unplacedFiles that are real changed files
  // AND not already placed (a file the model lists in both a section and
  // unplacedFiles must not render twice).
  const modelUnplaced = sanitizeUnplacedFiles(output.unplacedFiles).filter((f) => changedSet.has(f) && !placed.has(f));
  const unplacedSet = new Set<string>(modelUnplaced);
  for (const file of changedFiles) {
    if (!placed.has(file)) unplacedSet.add(file);
  }
  const unplacedFiles = [...unplacedSet];

  const guide: CodeGuideOutput = {
    // Marker engines are prompt-enforced only (no schema flag) — a non-string
    // title/intent would otherwise reach the client verbatim and crash
    // GuideView (React child error, or renderInlineMarkdown's .split on a
    // non-string).
    title: typeof output.title === "string" && output.title.trim().length > 0 ? output.title : "Guided review",
    intent: typeof output.intent === "string" ? output.intent : "",
    sections: validatedSections,
    ...(unplacedFiles.length > 0 && { unplacedFiles }),
  };

  return { guide };
}
