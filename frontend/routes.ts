import type { Component } from 'vue';
import { matchSourcesRoute } from './sources/routes';

export interface RouteProps { url: URL }
export interface RouteEvents {
  navigate: [href: string];
  refresh: [];
}

interface DomainRoute {
  id: string;
  paths: string[];
  exact?: string[];
  match?: (url: URL) => boolean;
  navigation: string;
  module?: string;
}

// A domain switches to Vue as soon as its route component is delivered.
// Keep the literal globs so Vite can split each domain into its own chunk.
const components = import.meta.glob<{ default: Component }>([
  './diary/DiaryRoute.vue',
  './workspace/*Route.vue',
  './connections/ConnectionsRoute.vue',
  './context/ContextRoute.vue',
  './sources/SourcesRoute.vue',
]);

export const domainRoutes: DomainRoute[] = [
  { id: 'diary', paths: ['diaries'], navigation: '/diaries', module: './diary/DiaryRoute.vue' },
  { id: 'projects', paths: ['projects'], navigation: '/create', module: './workspace/ProjectRoute.vue' },
  { id: 'workspace', paths: [], exact: ['/create', '/workspace'], navigation: '/create', module: './workspace/WorkspaceRoute.vue' },
  { id: 'connections', paths: [], exact: ['/settings', '/settings/connections'], navigation: '/settings', module: './connections/ConnectionsRoute.vue' },
  { id: 'context', paths: [], exact: ['/author-context'], navigation: '/create', module: './context/ContextRoute.vue' },
  { id: 'characters', paths: ['characters'], navigation: '/characters', module: './workspace/CharacterRoute.vue' },
  { id: 'sources', paths: [], match: matchSourcesRoute, navigation: '/sources', module: './sources/SourcesRoute.vue' },
  { id: 'source-legacy', paths: ['sources', 'judgments', 'research'], navigation: '/sources' },
  { id: 'writing', paths: ['scenes', 'drafts', 'chapters', 'branches', 'events', 'narratives', 'templates', 'writing-requirements', 'generation-plans', 'compositions'], navigation: '/create', module: './workspace/WritingRoute.vue' },
  { id: 'tasks', paths: ['jobs', 'tasks', 'generations', 'generation-batches', 'media'], navigation: '/jobs', module: './workspace/TaskRoute.vue' },
];

export function domainFor(url: URL) {
  if (url.pathname === '/' && url.searchParams.has('projectId')) return domainRoutes[0];
  return domainRoutes.find(domain => domain.match?.(url) || domain.exact?.includes(url.pathname) || domain.paths.includes(url.pathname.split('/')[1] ?? ''));
}

export function routeLoader(url: URL) {
  const domain = domainFor(url);
  return domain?.module ? components[domain.module] : undefined;
}

export function currentNavigation(url: URL): string {
  if (/^\/settings(?:\/|$)/.test(url.pathname)) return '/settings';
  return domainFor(url)?.navigation ?? '/';
}
