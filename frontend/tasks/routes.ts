export type TasksRoute = { kind: 'list' } | { kind: 'job' | 'media'; id: string };

export function resolveTasksRoute(url: URL): TasksRoute | undefined {
  if (/^\/(?:jobs|tasks)\/?$/.test(url.pathname)) return { kind: 'list' };
  const match = /^\/(jobs|tasks|media)\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return;
  let id: string;
  try { id = decodeURIComponent(match[2]!); } catch { return; }
  if (id === 'new' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
  // Editing and action URLs still belong to the existing operation pages.
  if (url.searchParams.has('edit') || url.searchParams.has('action')) return;
  return { kind: match[1] === 'media' ? 'media' : 'job', id };
}

export function matchTasksRoute(url: URL): boolean {
  return resolveTasksRoute(url) !== undefined;
}
