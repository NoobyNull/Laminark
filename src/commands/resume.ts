import type { StashManager } from '../storage/stash-manager.js';
import type { StashObservation } from '../types/stash.js';

/**
 * Result of the /laminark:resume command.
 */
export interface ResumeResult {
  success: boolean;
  message: string;
  context?: StashObservation[];
}

/**
 * Dependencies injected into the resume command handler.
 */
export interface ResumeDeps {
  stashManager: StashManager;
}

/**
 * Returns a human-readable relative time string from an ISO date.
 * Examples: "just now", "2 minutes ago", "3 hours ago", "yesterday", "5 days ago"
 */
export function timeAgo(dateString: string, now?: Date): string {
  const date = new Date(dateString);
  const ref = now ?? new Date();
  const diffMs = ref.getTime() - date.getTime();

  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  return `${months} months ago`;
}

/**
 * Truncates a string to maxLen characters, appending "..." if truncated.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

/**
 * Handles the /laminark:resume slash command.
 *
 * Two modes:
 * 1. List mode (no stashId): shows stashed context threads
 * 2. Resume mode (stashId provided): restores context from a specific stash
 */
export async function handleResumeCommand(
  args: { projectId: string; stashId?: string },
  deps: ResumeDeps,
): Promise<ResumeResult> {
  const { stashManager } = deps;

  // Resume mode: restore a specific stash
  if (args.stashId) {
    const stash = stashManager.getStash(args.stashId);
    if (!stash) {
      return { success: false, message: `Stash not found: ${args.stashId}` };
    }

    stashManager.resumeStash(args.stashId);

    const count = stash.observationSnapshots.length;
    return {
      success: true,
      message: `Resumed: "${stash.topicLabel}"\n\nContext restored with ${count} observations.`,
      context: stash.observationSnapshots,
    };
  }

  // List mode: show available stashed threads
  const stashes = stashManager.listStashes(args.projectId, {
    status: 'stashed',
    limit: 5,
  });

  if (stashes.length === 0) {
    return { success: true, message: 'No stashed context threads found.' };
  }

  const lines = ['Stashed context threads:'];
  for (let i = 0; i < stashes.length; i++) {
    const s = stashes[i];
    const ago = timeAgo(s.createdAt);
    const summary = truncate(s.summary, 80);
    lines.push(`${i + 1}. ${s.topicLabel} (${ago}) - ${summary}`);
  }
  lines.push('');
  lines.push('Use /laminark:resume {id} to restore a thread.');

  return { success: true, message: lines.join('\n') };
}
