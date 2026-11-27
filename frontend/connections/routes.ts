/** Register this predicate with the shell alongside ConnectionsRoute.vue. */
export function matchesConnectionsRoute(url: URL): boolean {
  return /^\/settings(?:\/connections)?\/?$/.test(url.pathname);
}
