import { writingRoute } from '../writing/routes.ts';

// Only reader URLs supplied by the evidence link can become return navigation.
export function manuscriptReturn(url: URL): string | undefined {
  const values = url.searchParams.getAll('returnTo');
  const value = values[0];
  if (values.length !== 1 || !value || /[\s\\\u0000-\u001f\u007f]/.test(value)) return;
  try {
    const destination = new URL(value, url.origin);
    if (destination.origin !== url.origin || !destination.href.startsWith(`${destination.origin}/`)
      || !['http:', 'https:'].includes(destination.protocol) || writingRoute(destination)?.page !== 'read') return;
    return destination.pathname + destination.search + destination.hash;
  } catch { return; }
}
