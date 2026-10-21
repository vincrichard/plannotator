import { isAbsolute } from 'node:path';
import { captureReviewTurn } from '@plannotator/shared/review-turn';

export async function runTurnSnapshotHook(input: unknown): Promise<void> {
  if (!input || typeof input !== 'object') throw new Error('Invalid turn hook input');
  const data = input as Record<string, unknown>;
  if (data.hook_event_name !== 'UserPromptSubmit' && data.hook_event_name !== 'Stop') return;
  if (typeof data.cwd !== 'string' || !isAbsolute(data.cwd) || typeof data.session_id !== 'string') {
    throw new Error('Turn hook requires an absolute cwd and session_id');
  }
  if (data.turn_id !== undefined && typeof data.turn_id !== 'string') throw new Error('Invalid turn_id');
  await captureReviewTurn(data.hook_event_name === 'UserPromptSubmit' ? 'start' : 'stop',
    data.cwd, data.session_id, typeof data.turn_id === 'string' ? data.turn_id : undefined);
}
