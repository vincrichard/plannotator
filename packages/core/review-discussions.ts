/** Questions are separate from review annotations until explicitly converted. */
export interface ReviewDiscussionAnchor {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new';
  scope?: 'line' | 'file' | 'general';
  charStart?: number;
  charEnd?: number;
  tokenText?: string;
  selectedText?: string;
  prUrl?: string;
  prNumber?: number;
  prTitle?: string;
  prRepo?: string;
  diffScope?: 'layer' | 'full-stack';
  commitSha?: string;
  commitSubject?: string;
  gitButlerDiffType?: string;
  gitButlerDiffLabel?: string;
  gitButlerBase?: string;
  gitButlerSnapshotId?: string;
  anchorText?: string;
  anchorContext?: { before: (string | null)[]; after: (string | null)[]; hunk?: string };
  anchorSnapshot?: string;
}

export interface ReviewDiscussionMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
}

export interface ReviewDiscussionComment extends ReviewDiscussionAnchor {
  id: string;
  type: 'comment';
  text: string;
  createdAt: number;
}

export interface ReviewDiscussion {
  id: string;
  anchor: ReviewDiscussionAnchor;
  snapshotId: string;
  messages: ReviewDiscussionMessage[];
  status: 'answering' | 'answered' | 'error' | 'resolved' | 'converted';
  error?: string;
  activity?: { startedAt: number; lastActivityAt?: number; waitRequestedAt?: number };
  createdAt: number;
  updatedAt: number;
  annotation?: ReviewDiscussionComment;
  conversionSaved?: boolean;
}

export interface ReviewDiscussionsSnapshot {
  supported: boolean;
  available: boolean;
  provider?: 'codex' | 'claude' | 'opencode';
  reason?: string;
  snapshotId: string;
  threads: ReviewDiscussion[];
  version: number;
}
