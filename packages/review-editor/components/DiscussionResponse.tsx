import React from 'react';
import { lexer } from 'marked';
import { CopyButton } from './CopyButton';
import { renderInlineMarkdown } from '../utils/renderInlineMarkdown';

/** Draft fences copy their contents; the response button copies the original Markdown. */
export function DiscussionResponse({ text }: { text: string }) {
  return <>
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>Agent</span>
      <CopyButton text={text} variant="inline" label="Copy response" />
    </div>
    <div className="review-comment-body">
      {lexer(text).map((token, index) => token.type === 'code' && token.lang === 'draft'
        ? <div key={index} className="my-2 min-w-0 rounded border border-border p-2">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Draft</span>
            <CopyButton text={token.text} variant="inline" label="Copy draft" />
          </div>
          <pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] font-sans text-xs">{token.text}</pre>
        </div>
        : <React.Fragment key={index}>{renderInlineMarkdown(token.raw)}</React.Fragment>)}
    </div>
  </>;
}
