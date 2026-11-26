import { createHash } from 'node:crypto';
import { jsonObject } from './composition.ts';
import type { Field, MediaPart, Message, Plan } from './contracts.ts';
import { makeRequestOptions } from './prompt.ts';

export interface GenerationProviderRequest {
  requestId: string;
  plan: Plan;
  messages: Message[];
  templateFields?: Field[];
  readMedia?: (part: MediaPart) => Buffer;
}

export interface GenerationProviderResponse {
  content: string | null;
  reportedModel: string | null;
  responseId: string | null;
  finishReason: string | null;
}

export interface GenerationProvider {
  prepare(request: GenerationProviderRequest): {
    endpoint?: string;
    requestOptions?: Record<string, unknown>;
    execute(signal: AbortSignal, onResponse?: () => void): Promise<GenerationProviderResponse>;
  };
}

export class GenerationProviderError extends Error {
  constructor(details: { state: 'failed' | 'uncertain'; code: string; message: string }) {
    super(details.message);
    this.state = details.state;
    this.code = details.code;
  }
  readonly state: 'failed' | 'uncertain';
  readonly code: string;
}

const maxResponseBytes = 1_000_000;

function providerMessages(messages: Message[], readMedia: GenerationProviderRequest['readMedia']) {
  return messages.map(({ role, content }) => ({ role, content: typeof content === 'string' ? content : content.map(part => {
    if (part.type === 'text') return part;
    const { assetId, contentType, byteLength, sha256 } = part.asset;
    const format = contentType === 'audio/wav' ? 'wav' : contentType === 'audio/mpeg' ? 'mp3' : undefined;
    if (part.type === 'audio' && format === undefined) {
      throw new GenerationProviderError({ state: 'failed', code: 'generation_provider_unsupported_audio',
        message: `Audio asset ${assetId} uses ${contentType}. OpenAI-compatible delegation requires WAV or MP3. Select a transcript or upload the audio in a supported format.` });
    }
    if (part.type === 'image' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType)) {
      throw new GenerationProviderError({ state: 'failed', code: 'generation_provider_unsupported_image',
        message: `Image asset ${assetId} uses ${contentType}. OpenAI-compatible delegation requires PNG, JPEG, WebP, or GIF.` });
    }
    const bytes = readMedia?.(part);
    if (!bytes || bytes.byteLength !== byteLength || createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new GenerationProviderError({ state: 'failed', code: 'generation_pinned_asset_unavailable',
        message: `Could not verify the pinned bytes for asset ${assetId}.` });
    }
    const data = bytes.toString('base64');
    return part.type === 'image' ? { type: 'image_url', image_url: { url: `data:${contentType};base64,${data}` } }
      : { type: 'input_audio', input_audio: { data, format } };
  }) }));
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new SyntaxError('Provider returned an empty body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        void reader.cancel().catch(() => {});
        throw new SyntaxError('Provider response exceeded 1,000,000 bytes.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function reportedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && value.length <= 512 ? value : null;
}

function invalidConfiguration(message: string): never {
  throw new Error(`STH_GENERATION_PROVIDERS_JSON ${message}`);
}

/** Set provider aliases on the server. Plans can select an alias and cannot supply a URL or secret. */
export function createOpenAICompatibleProvider(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): GenerationProvider {
  let config: Record<string, unknown> | undefined;
  try {
    config = jsonObject(JSON.parse(env.STH_GENERATION_PROVIDERS_JSON?.trim() || '{}'));
  } catch {
    invalidConfiguration('must contain valid JSON.');
  }
  if (!config) invalidConfiguration('must map provider aliases to settings objects.');
  const providers = new Map<string, { endpoint: string; apiKeyEnv?: string }>();
  for (const [alias, value] of Object.entries(config)) {
    const settings = jsonObject(value);
    const invalidShape = !settings || typeof settings.baseUrl !== 'string'
      || Object.keys(settings).some(key => key !== 'baseUrl' && key !== 'apiKeyEnv')
      || (settings.apiKeyEnv !== undefined && (typeof settings.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.apiKeyEnv)));
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(alias) || invalidShape) {
      invalidConfiguration('requires valid aliases with baseUrl and an optional apiKeyEnv variable name.');
    }
    const url = URL.parse(settings.baseUrl as string);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      invalidConfiguration('requires HTTP(S) base URLs without credentials, queries, or fragments.');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
    providers.set(alias, { endpoint: url.href, apiKeyEnv: settings.apiKeyEnv as string | undefined });
  }

  return {
    prepare({ requestId, plan, messages, templateFields, readMedia }) {
      const provider = providers.get(plan.provider);
      if (!provider) throw new GenerationProviderError({ state: 'failed', code: 'generation_provider_not_configured',
        message: `Configure the provider alias ${plan.provider} in STH_GENERATION_PROVIDERS_JSON.` });
      const apiKey = provider.apiKeyEnv === undefined ? undefined : env[provider.apiKeyEnv];
      if (provider.apiKeyEnv !== undefined && (!apiKey?.trim() || /[\r\n\0]/.test(apiKey))) {
        throw new GenerationProviderError({ state: 'failed', code: 'generation_provider_key_missing',
          message: `Set a valid API key in ${provider.apiKeyEnv} for provider ${plan.provider}.` });
      }
      if (plan.parameters.responseFormat === 'json-schema' && !templateFields?.length) {
        throw new GenerationProviderError({ state: 'failed', code: 'generation_provider_schema_missing',
          message: 'JSON Schema response format requires pinned template fields.' });
      }
      const requestOptions = makeRequestOptions(plan, templateFields);
      const body = JSON.stringify({ ...requestOptions, messages: providerMessages(messages, readMedia) });
      return {
        endpoint: provider.endpoint,
        requestOptions,
        async execute(signal, onResponse) {
          const response = await request(provider.endpoint, {
            method: 'POST', redirect: 'error', signal, body,
            headers: {
              'Content-Type': 'application/json', 'Idempotency-Key': requestId,
              ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }),
            },
          });
          onResponse?.();
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            const rejected = response.status >= 400 && response.status < 500 && ![408, 409, 499].includes(response.status);
            throw new GenerationProviderError({
              state: rejected ? 'failed' : 'uncertain', code: 'generation_provider_http_error',
              message: `Text provider returned HTTP ${response.status}.`,
            });
          }
          let data: Record<string, unknown> | undefined;
          try {
            data = jsonObject(await readJson(response));
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
          if (!data) throw new GenerationProviderError({ state: 'failed', code: 'generation_provider_invalid_response',
            message: 'Provider response was empty, oversized, or invalid JSON.' });
          const choice = Array.isArray(data.choices) ? jsonObject(data.choices[0]) : undefined;
          const message = jsonObject(choice?.message);
          return {
            content: typeof message?.content === 'string' ? message.content : null,
            reportedModel: reportedString(data.model), responseId: reportedString(data.id),
            finishReason: reportedString(choice?.finish_reason),
          };
        },
      };
    },
  };
}
