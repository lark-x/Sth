import { matchWritingRoute } from '../writing/routes';

export function collectionRoute(url: URL) {
  const path = url.pathname.replace(/\/$/, '');
  if (url.searchParams.get('view') === 'overview' || url.searchParams.has('q')) return false;
  if (path === '/diaries') return !url.search;
  if (path === '/workspace') return url.searchParams.get('tab') === 'recent';
  if (path === '/create') return !url.search;
  return /^\/projects(?:\/(?!new$)[^/]+)?$/.test(path);
}

export function manuscriptRoute(url: URL) {
  return collectionRoute(url) || matchWritingRoute(url) || /^\/diaries\/[^/]+\/?$/.test(url.pathname) || url.pathname === '/projects/new';
}
