export type CharacterRoute = { page: 'index' | 'new' } | { page: 'detail'; characterId: string };

// Hubble can register this matcher before the legacy character fallback.
export function characterRoute(url: URL): CharacterRoute | undefined {
  if (url.searchParams.has('action')) return;
  if (/^\/characters\/?$/.test(url.pathname)) return { page: 'index' };
  if (/^\/characters\/new\/?$/.test(url.pathname)) return { page: 'new' };
  const match = /^\/characters\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return;
  let characterId: string;
  try { characterId = decodeURIComponent(match[1]!); } catch { return; }
  if (!characterId.trim() || characterId.length > 128 || /[/\\\u0000-\u001f\u007f]/.test(characterId)) return;
  return { page: 'detail', characterId };
}

export const matchCharactersRoute = (url: URL): boolean => characterRoute(url) !== undefined;
