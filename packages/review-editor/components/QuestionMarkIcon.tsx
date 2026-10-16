import React from 'react';

export const QuestionMarkIcon: React.FC<{ className?: string }> = ({ className = 'w-3 h-3' }) => (
  <svg className={`${className} flex-shrink-0`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 7a4 4 0 0 1 8 0c0 3-4 3-4 6" />
    <circle cx="12" cy="18" r="1" fill="currentColor" stroke="none" />
  </svg>
);
