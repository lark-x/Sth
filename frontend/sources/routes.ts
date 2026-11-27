export type SourceRoute = { page: 'index' | 'new' } |
  { page: 'detail' | 'revise' | 'adopt-entry' | 'impact'; sourceId: string };

// Register this predicate before the legacy domain loader. Unknown actions and
// additional path segments deliberately remain owned by that loader.
export function sourceRoute(url: URL): SourceRoute | undefined {
  const actions = url.searchParams.getAll('action');
  if (actions.length > 1) return;
  const action = actions[0] ?? '';
  if (/^\/sources\/?$/.test(url.pathname)) return action ? undefined : { page: 'index' };
  if (/^\/sources\/new\/?$/.test(url.pathname)) return action ? undefined : { page: 'new' };
  const match = /^\/sources\/([^/]+)\/?$/.exec(url.pathname);
  if (!match || !['', 'revise', 'adopt-entry', 'impact'].includes(action)) return;
  let sourceId: string;
  try { sourceId = decodeURIComponent(match[1]!); } catch { return; }
  if (!sourceId.trim() || sourceId.length > 128 || /[/\\\u0000-\u001f\u007f]/.test(sourceId)) return;
  return { page: action ? action as 'revise' | 'adopt-entry' | 'impact' : 'detail', sourceId };
}

export const matchSourcesRoute = (url: URL): boolean => sourceRoute(url) !== undefined;
