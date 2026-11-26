import { ExternalProviderError, maxSearchResults, type ExternalProvider } from './external-contracts.ts';

const maxResponseBytes = 12 * 1024 * 1024;
const defaultWiki = 'https://zh.wikipedia.org/w/api.php';
const protocolVersions = ['2025-03-26', '2025-06-18', '2025-11-25'];
type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function invalidResponse(): never {
  throw new ExternalProviderError('external_invalid_response', 'The provider returned an unexpected response.', true);
}

function tooLarge(): never {
  throw new ExternalProviderError('external_response_too_large', 'The provider response exceeds the research size limit.');
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) invalidResponse();
  return value;
}

function requiredArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalidResponse();
  return value;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return invalidResponse(); }
}

function integerId(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalidResponse();
  return String(value);
}

function parseInteger(value: string, minimum: number): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || String(parsed) !== value || parsed < minimum) {
    throw new ExternalProviderError('external_invalid_reference', 'The document ID or continuation cursor is invalid.');
  }
  return parsed;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
}

function endpoint(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('An external research endpoint must be an HTTP(S) URL without credentials or a fragment.');
  }
  return url;
}

async function request(url: URL, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw new ExternalProviderError('external_provider_http', `The provider returned HTTP ${response.status}.`, retryable);
  }
  return response;
}

async function* responseText(response: Response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) tooLarge();
      yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function responseJson(response: Response): Promise<JsonObject> {
  let text = '';
  for await (const part of responseText(response)) text += part;
  return record(parseJson(text)) ?? invalidResponse();
}

export function createMediaWikiProvider({ apiUrl = defaultWiki, provider = 'wikipedia-zh',
  label = '中文维基百科', userAgent = 'SthResearch/0.1 (personal reference client)',
  license = apiUrl === defaultWiki ? 'CC BY-SA 4.0 (see article for attribution and exceptions)' : undefined,
}: { apiUrl?: string; provider?: string; label?: string; userAgent?: string; license?: string } = {}): ExternalProvider {
  const api = endpoint(apiUrl);

  async function query(params: Record<string, string>, signal: AbortSignal) {
    const url = new URL(api);
    for (const [key, value] of Object.entries({ action: 'query', format: 'json', formatversion: '2', ...params })) {
      url.searchParams.set(key, value);
    }
    const data = await responseJson(await request(url, { headers: { 'User-Agent': userAgent }, signal }));
    const error = record(data.error);
    if (error) {
      const code = typeof error.code === 'string' && /^[a-z\d_-]{1,64}$/i.test(error.code) ? error.code : 'unknown';
      throw new ExternalProviderError('external_mediawiki_error', `MediaWiki reported ${code}.`,
        ['maxlag', 'readonly', 'ratelimited', 'internal_api_error'].some(prefix => code.startsWith(prefix)));
    }
    return data;
  }

  function metadata(page: JsonObject) {
    const docId = integerId(page.pageid);
    const url = endpoint(requiredText(page.canonicalurl ?? page.fullurl)).href;
    const upstreamRevision = page.lastrevid === undefined ? undefined : integerId(page.lastrevid);
    const origin = [url, upstreamRevision === undefined ? undefined : `revision ${upstreamRevision}`, license].filter(Boolean).join(' · ');
    return { provider, docId, title: clip(requiredText(page.title), 300), url, origin,
      ...(upstreamRevision === undefined ? {} : { upstreamRevision }), ...(license === undefined ? {} : { license }) };
  }

  return {
    provider, label, kind: 'mediawiki',
    async search({ query: term, limit, cursor }, signal) {
      const offset = cursor === undefined ? undefined : parseInteger(cursor, 0);
      const data = await query({ generator: 'search', gsrsearch: term, gsrlimit: String(limit), gsrnamespace: '0',
        prop: 'info|extracts', inprop: 'url', exintro: '1', explaintext: '1', exlimit: String(limit), exchars: '1000',
        ...(offset === undefined ? {} : { gsroffset: String(offset), continue: 'gsroffset||' }),
      }, signal);
      const pages = record(data.query)?.pages;
      const items = (pages === undefined ? [] : requiredArray(pages)).map(page => record(page) ?? invalidResponse())
        .sort((a, b) => Number(a.index) - Number(b.index)).slice(0, limit).map(page => ({
          ...metadata(page), ...(typeof page.extract === 'string' ? { snippet: clip(page.extract, 1000) } : {}),
        }));
      const next = record(data.continue)?.gsroffset;
      return { items, ...(next === undefined ? {} : { nextCursor: integerId(next) }) };
    },
    async read({ docId, cursor }, signal) {
      parseInteger(docId, 1);
      if (cursor !== undefined) throw new ExternalProviderError('external_invalid_reference', 'MediaWiki document reads have no provider continuation.');
      const data = await query({ pageids: docId, prop: 'info|extracts', inprop: 'url', explaintext: '1', exlimit: '1', exsectionformat: 'wiki' }, signal);
      const page = record(requiredArray(record(data.query)?.pages)[0]);
      if (!page || page.missing || page.invalid) throw new ExternalProviderError('external_document_not_found', 'MediaWiki did not find this page.');
      if (typeof page.extract !== 'string' || !page.extract.trim()) {
        throw new ExternalProviderError('external_no_original', 'MediaWiki did not return a plain-text article for this page.');
      }
      return { documents: [{ ...metadata(page), body: page.extract }] };
    },
  };
}

async function sseReply(response: Response, id: number): Promise<JsonObject> {
  let buffer = '';
  let data: string[] = [];
  for await (const part of responseText(response)) {
    buffer += part;
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      if (line === '' && data.length > 0) {
        const message = record(parseJson(data.join('\n')));
        if (message?.id === id) return message;
        data = [];
      }
      end = buffer.indexOf('\n');
    }
  }
  return invalidResponse();
}

export function createAkashaProvider({ url, authorization }: { url: string; authorization?: string }): ExternalProvider {
  const api = endpoint(url);
  const provider = 'akasha';

  async function callTool(name: string, args: JsonObject, signal: AbortSignal) {
    const headers = new Headers({ Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' });
    if (authorization) headers.set('Authorization', authorization);

    async function post(method: string, params?: JsonObject, id?: number): Promise<JsonObject | undefined> {
      const response = await request(api, { method: 'POST', headers, signal, body: JSON.stringify({ jsonrpc: '2.0', method, params, id }) });
      if (id === undefined) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      if (method === 'initialize') {
        const session = response.headers.get('mcp-session-id');
        if (session) headers.set('Mcp-Session-Id', session);
      }
      const message = response.headers.get('content-type')?.includes('text/event-stream')
        ? await sseReply(response, id) : await responseJson(response);
      if (message.id !== id || message.jsonrpc !== '2.0') invalidResponse();
      if (message.error) throw new ExternalProviderError('external_mcp_error', 'The Akasha MCP request failed.', true);
      return record(message.result) ?? invalidResponse();
    }

    try {
      const init = await post('initialize', { protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'sth-research', version: '0.1.0' } }, 1);
      const version = requiredText(init?.protocolVersion);
      if (!protocolVersions.includes(version)) {
        throw new ExternalProviderError('external_mcp_protocol', 'The Akasha MCP server selected an unsupported protocol version.');
      }
      headers.set('MCP-Protocol-Version', version);
      await post('notifications/initialized');
      const result = await post('tools/call', { name, arguments: args }, 2);
      if (result?.isError) throw new ExternalProviderError('external_akasha_tool_error', 'The Akasha tool reported an error.', true);
      const structured = record(result?.structuredContent);
      if (structured) return structured;
      const text = requiredArray(result?.content).map(record).find(item => item?.type === 'text')?.text;
      return record(parseJson(requiredText(text))) ?? invalidResponse();
    } finally {
      if (headers.has('Mcp-Session-Id') && !signal.aborted) {
        try {
          const response = await fetch(api, { method: 'DELETE', headers, redirect: 'manual',
            signal: AbortSignal.any([signal, AbortSignal.timeout(500)]) });
          void response.body?.cancel().catch(() => {});
        } catch { /* Session termination is optional in Streamable HTTP. */ }
      }
    }
  }

  function hit(value: unknown) {
    const item = record(value) ?? invalidResponse();
    const origin = requiredText(item.cite);
    return { provider, docId: integerId(item.chunkId), title: clip(origin, 300), origin,
      body: requiredText(item.excerpt) };
  }

  return {
    provider, label: 'Akasha 原文资料库', kind: 'mcp-akasha',
    async search({ query, limit, cursor }, signal) {
      if (cursor !== undefined) throw new ExternalProviderError('external_invalid_reference', 'Akasha search has no continuation cursor.');
      const data = await callTool('searchAkasha', { query, topK: Math.min(limit, maxSearchResults) }, signal);
      return { items: requiredArray(data.results).slice(0, limit).map(value => {
        const { body, ...item } = hit(value);
        return { ...item, snippet: clip(body, 2000) };
      }) };
    },
    async read({ docId, cursor }, signal) {
      const chunkId = parseInteger(docId, 1);
      const offset = cursor === undefined ? undefined : parseInteger(cursor, 0);
      const data = await callTool('readSource', { chunkId, scope: 'source', limit: 3, ...(offset === undefined ? {} : { offset }) }, signal);
      const documents = requiredArray(data.results).map(hit);
      if (!documents.length) throw new ExternalProviderError('external_document_not_found', 'Akasha did not return any original text for this reference.');
      const next = record(data.pagination)?.nextOffset;
      return { documents, ...(next === undefined || next === null ? {} : { nextCursor: integerId(next) }) };
    },
  };
}

export function createExternalProviders(env: NodeJS.ProcessEnv = process.env): ExternalProvider[] {
  const providers: ExternalProvider[] = [];
  if (env.STH_RESEARCH_AKASHA_URL) providers.push(createAkashaProvider({
    url: env.STH_RESEARCH_AKASHA_URL, authorization: env.STH_RESEARCH_AKASHA_AUTHORIZATION,
  }));
  if (env.STH_RESEARCH_MEDIAWIKI_URL !== 'off') {
    const apiUrl = env.STH_RESEARCH_MEDIAWIKI_URL || defaultWiki;
    const customWiki = apiUrl !== defaultWiki;
    const provider = env.STH_RESEARCH_MEDIAWIKI_ID || (customWiki ? '' : 'wikipedia-zh');
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider) || provider === 'akasha' || (customWiki && provider === 'wikipedia-zh')) {
      throw new Error('A custom MediaWiki endpoint requires a distinct STH_RESEARCH_MEDIAWIKI_ID.');
    }
    providers.push(createMediaWikiProvider({ apiUrl, provider, label: env.STH_RESEARCH_MEDIAWIKI_LABEL || (customWiki ? provider : undefined),
      userAgent: env.STH_RESEARCH_MEDIAWIKI_USER_AGENT || undefined, license: env.STH_RESEARCH_MEDIAWIKI_LICENSE || undefined }));
  }
  return providers;
}
