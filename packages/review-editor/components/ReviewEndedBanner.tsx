import React from 'react';
import { getPendingReviewDrafts } from '../hooks/useAnnotationToolbar';
import { useReviewDiscussions } from '../hooks/useReviewDiscussions';

export function ReviewEndedBanner() {
  const discussions = useReviewDiscussions();
  if (!discussions?.connectionError) return null;
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ questions: discussions.failedQuestions, followUps: discussions.drafts, composers: getPendingReviewDrafts() }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'unsent-review-questions.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div role="alert" className="fixed bottom-0 inset-x-0 z-[3000] bg-background border-t border-destructive p-3 text-sm flex items-center gap-3">
    <span>{discussions.connectionError}</span>
    <button className="review-toolbar-btn flex-shrink-0" onClick={download}>Download saved questions</button>
  </div>;
}
