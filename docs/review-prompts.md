# Editable guided-review prompts

Server-generated guides read optional Markdown files from `review_prompts/`
inside the Plannotator data directory (`PLANNOTATOR_DATA_DIR`, or the normal
application data directory). These are complete overrides of the corresponding
built-in instructions:

- `guided-review.md`: organization, lifecycle explanation, section overviews and block summaries. Default: `GUIDE_REVIEW_PROMPT` in `packages/core/guide-prompt.ts`.
- `block-repair.md`: targeted coverage and block repairs. Default: `guideBlockRepairPrompt` in `packages/server/guide/guide-block-authoring.ts`.
- `json-repair.md`: malformed-output repair. Default: `buildGuideRepairFraming` in `packages/server/guide/guide-review.ts`.

Save a file, then explicitly generate or regenerate a guide. Each operation
reads its prompt again, so no server restart is needed after editing. Missing
or blank files use the bundled defaults; unreadable files report an error.
Existing guides and requests already in progress retain their previous content.
Additional reviewer preferences are still appended. Output schemas, read-only
permissions and coverage validation remain enforced by the application.

The interactive review renders Markdown tables, lists, emphasis and Mermaid
fences in section overviews and block summaries. Focused offline HTML exports
retain their static text layout. Other lightweight viewer hosts keep their
existing rendering unless they supply `renderExplanation`.

A vault folder can contain the actual Markdown files and be tracked by a
separate Git repository. Link the application's `review_prompts` directory to
that folder; the companion durable launcher shares that directory with each
review. Vault synchronization and Git commits remain separate operations.
Never commit review data or credentials with your prompts.

Browser-only generation helpers and guides written independently by an external
agent still use their own instructions. This feature does not request or create
a guided review automatically.
