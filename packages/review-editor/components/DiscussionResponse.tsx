import React, { lazy, Suspense } from 'react';
import { RenderedMarkdown } from '@plannotator/ui/components/RenderedMarkdown';
import type { Block } from '@plannotator/ui/types';
import { CopyButton } from './CopyButton';

const MermaidBlock = lazy(async () => ({ default: (await import('@plannotator/ui/components/MermaidBlock')).MermaidBlock }));

function renderCodeBlock(block: Block) {
  if (block.language === 'mermaid') return <Suspense fallback={<pre className="overflow-x-auto">{block.content}</pre>}>
    <MermaidBlock block={block} readOnly />
  </Suspense>;
  if (block.language === 'draft') return <div className="my-2 min-w-0 rounded border border-border p-2">
    <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>Draft</span>
      <CopyButton text={block.content} variant="inline" label="Copy draft" />
    </div>
    <pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] font-sans text-xs">{block.content}</pre>
  </div>;
}

export function DiscussionMarkdown({ text }: { text: string }) {
  return <RenderedMarkdown markdown={text} renderCodeBlock={renderCodeBlock} className="review-comment-body ai-markdown md-compact min-w-0" />;
}

/** Draft fences copy their contents; the response button copies the original Markdown. */
export function DiscussionResponse({ text }: { text: string }) {
  return <>
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>Agent</span>
      <CopyButton text={text} variant="inline" label="Copy response" />
    </div>
    <DiscussionMarkdown text={text} />
  </>;
}
