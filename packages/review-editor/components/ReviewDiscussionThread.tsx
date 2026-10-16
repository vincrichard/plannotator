import React, { useState } from 'react';
import type { ReviewDiscussion } from '../../core/review-discussions';
import { useReviewDiscussions } from '../hooks/useReviewDiscussions';
import { renderInlineMarkdown } from '../utils/renderInlineMarkdown';

export function ReviewDiscussionThread({ thread }: { thread: ReviewDiscussion }) {
  const discussions = useReviewDiscussions()!;
  const expanded = discussions.expandedThreads[thread.id] ?? false;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [converting, setConverting] = useState(false);
  const draft = discussions.drafts[thread.id] ?? '';
  const readonly = thread.snapshotId !== discussions.snapshotId;
  const busy = pending || thread.status === 'answering' || discussions.ended;
  const unread = thread.status === 'answered' && discussions.seen[thread.id] !== thread.updatedAt;
  const run = async (action: () => Promise<unknown>) => {
    setPending(true); setError(undefined);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const send = () => run(async () => { await discussions.send(thread.id, draft.trim()); discussions.setDraft(thread.id, ''); });
  return <section className="review-comment" data-discussion-id={thread.id}>
    <button className="w-full text-left text-xs flex items-center gap-2" aria-expanded={expanded} onClick={() => { discussions.setThreadExpanded(thread.id, !expanded); discussions.markRead(thread); }}>
      <span className="font-medium">Discussion</span>
      <span className="text-muted-foreground">{thread.status === 'answering' ? 'Answering…' : thread.status === 'answered' ? 'Answered' : thread.status === 'resolved' ? 'Resolved' : 'Needs attention'}</span>
      {unread && <span className="text-primary">Unread</span>}
      <span className="truncate ml-auto">{thread.messages[0]?.text}</span>
    </button>
    {expanded && <div className="mt-3 space-y-3">
      {thread.messages.map(message => <div key={message.id}>
        <div className="text-xs text-muted-foreground">{message.role === 'user' ? 'You' : 'Agent'}</div>
        <div className="review-comment-body">{renderInlineMarkdown(message.text)}</div>
      </div>)}
      {(discussions.ended || error || thread.error) && <p role="alert" className="text-xs text-destructive">{discussions.ended ? discussions.error : error ?? thread.error}</p>}
      {!discussions.conversionReady && <p className="text-xs text-muted-foreground">{discussions.conversionUnavailableReason}</p>}
      {readonly && <p className="text-xs text-muted-foreground">This discussion belongs to another review snapshot.</p>}
      {thread.status === 'resolved' ? <button className="review-toolbar-btn" disabled={pending || readonly} onClick={() => void run(() => discussions.update(thread.id, 'reopen'))}>Reopen</button> : <>
        <label className="block text-xs">
          {converting ? 'Change request (sent with final feedback)' : 'Follow-up question'}
          <textarea className="mt-1 w-full p-2 bg-muted rounded text-xs" aria-label={converting ? 'Change request' : 'Follow-up question'} rows={3} value={draft} disabled={pending || readonly}
            onChange={event => discussions.setDraft(thread.id, event.target.value)}
            onKeyDown={event => { if (!converting && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && draft.trim() && !busy) { event.preventDefault(); void send(); } }} />
        </label>
        <div className="flex flex-wrap gap-2">
          {converting ? <>
            <button className="review-toolbar-btn primary" disabled={busy || readonly || !draft.trim() || !discussions.conversionReady} onClick={() => void run(async () => { await discussions.update(thread.id, 'convert', draft.trim()); discussions.setDraft(thread.id, ''); })}>Save change request</button>
            <button className="review-toolbar-btn" onClick={() => setConverting(false)}>Cancel</button>
          </> : <>
            <button className="review-toolbar-btn primary" disabled={busy || readonly || !draft.trim() || !discussions.available} onClick={() => void send()}>Send question</button>
            <button className="review-toolbar-btn" disabled={busy || readonly || !discussions.conversionReady} onClick={() => { setConverting(true); if (!draft.trim()) discussions.setDraft(thread.id, [...thread.messages].reverse().find(message => message.role === 'user')?.text ?? ''); }}>Request change</button>
            <button className="review-toolbar-btn" disabled={pending} onClick={() => void run(() => discussions.update(thread.id, 'resolve'))}>Resolve</button>
          </>}
        </div>
      </>}
    </div>}
  </section>;
}

export function ReviewDiscussionsTab({ onNavigate }: { onNavigate?: (file: string, start: number, end: number, side: 'old' | 'new') => void }) {
  const discussions = useReviewDiscussions()!;
  const [showResolved, setShowResolved] = useState(false);
  const [sending, setSending] = useState(false);
  const generalDraft = discussions.drafts.general ?? '';
  const sendGeneral = async () => {
    setSending(true);
    if (await discussions.create({ scope: 'general', filePath: '', lineStart: 0, lineEnd: 0, side: 'new' }, generalDraft.trim())) discussions.setDraft('general', '');
    setSending(false);
  };
  const threads = discussions.threads.filter(thread => thread.status !== 'converted' && (showResolved || thread.status !== 'resolved'));
  return <div className="p-3 space-y-3">
    <p className="text-xs text-muted-foreground">Ask agent on selected code. Answers appear here while you keep reviewing. Change requests are sent with final feedback.</p>
    {!discussions.available && <p role="status" className="text-xs">{discussions.reason ?? 'Agent discussions are unavailable for this review.'}</p>}
    {discussions.error && <p role="alert" className="text-xs text-destructive">{discussions.error}</p>}
    {Object.values(discussions.failedQuestions).map(question => <div key={question.id} className="text-xs"><p>{question.text}</p><button className="review-toolbar-btn" onClick={() => void discussions.create(question.anchor, question.text, question.codeContext, question)}>Retry question</button></div>)}
    <label className="block text-xs">Ask about this review<textarea aria-label="Ask about this review" className="mt-1 w-full p-2 bg-muted rounded text-xs" value={generalDraft} onChange={event => discussions.setDraft('general', event.target.value)} /></label>
    <button className="review-toolbar-btn primary" disabled={sending || !discussions.available || !generalDraft.trim()} onClick={() => void sendGeneral()}>Ask agent</button>
    <label className="text-xs flex gap-2"><input type="checkbox" checked={showResolved} onChange={event => setShowResolved(event.target.checked)} />Show resolved</label>
    {threads.map(thread => <div key={thread.id}>
      <button className="text-xs text-primary mb-1" disabled={thread.snapshotId !== discussions.snapshotId} onClick={() => onNavigate?.(thread.anchor.filePath, thread.anchor.lineStart, thread.anchor.lineEnd, thread.anchor.side)}>{thread.anchor.scope === 'general' ? 'Review discussion' : `${thread.anchor.filePath}:${thread.anchor.lineStart}–${thread.anchor.lineEnd} (${thread.anchor.side})`}</button>
      <ReviewDiscussionThread thread={thread} />
    </div>)}
  </div>;
}
