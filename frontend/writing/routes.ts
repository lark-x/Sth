export type WritingRoute =
  | { kind: 'scene'; id: string; page: 'read' | 'compare' | 'branch' }
  | { kind: 'draft'; id: string; page: 'read' | 'revise' | 'adopt' }
  | { kind: 'draft'; page: 'new' };

// Unknown actions, narrative aliases and deeper paths keep their complete
// original URL and remain owned by the legacy writing domain.
export function writingRoute(url: URL): WritingRoute | undefined {
  const actions = url.searchParams.getAll('action');
  if (actions.length > 1 || url.searchParams.has('narrativeId')) return;
  const action = actions[0] ?? '';
  const match = /^\/(scenes|drafts)\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return;
  let id: string;
  try { id = decodeURIComponent(match[2]!); } catch { return; }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
  if (id === 'new') return match[1] === 'drafts' && !action ? { kind: 'draft', page: 'new' } : undefined;
  if (match[1] === 'scenes' && ['', 'compare', 'branch'].includes(action)) {
    return { kind: 'scene', id, page: (action || 'read') as 'read' | 'compare' | 'branch' };
  }
  if (match[1] === 'drafts' && ['', 'revise', 'adopt'].includes(action)) {
    return { kind: 'draft', id, page: (action || 'read') as 'read' | 'revise' | 'adopt' };
  }
}

export const matchWritingRoute = (url: URL): boolean => writingRoute(url) !== undefined;
