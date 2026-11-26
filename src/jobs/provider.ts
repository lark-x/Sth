import { readFileSync } from 'node:fs';
import { maxImageBytes, sha256 } from './storage.ts';

export type ProviderParameters = Record<string, string | number | boolean>;
export type ProviderRequest = { requestId: string; prompt: string };
export type LookupRequest = { requestId: string; providerJobId?: string; parameters: ProviderParameters };
export type SubmitResult =
  | { state: 'submitted'; providerJobId: string }
  | { state: 'failed' | 'unknown'; message: string };
export type LookupResult =
  | { state: 'submitted'; providerJobId: string }
  | { state: 'failed' | 'unknown'; message: string; providerJobId?: string }
  | { state: 'succeeded'; providerJobId: string; bytes: Uint8Array };

export interface MediaProvider {
  readonly name: string;
  /** Identify the queue/history endpoint independently of workflow settings. */
  readonly key: string;
  readonly parameters: ProviderParameters;
  checkAvailability?(signal: AbortSignal): Promise<boolean>;
  submit(request: ProviderRequest, signal: AbortSignal): Promise<SubmitResult>;
  lookup(request: LookupRequest, signal: AbortSignal): Promise<LookupResult>;
}

export type MediaProviderStatus = {
  status: 'unconfigured' | 'invalid_config' | 'ready' | 'unreachable';
  provider?: string;
  message: string;
};

export async function getMediaProviderStatus(provider?: MediaProvider, invalidConfig = false): Promise<MediaProviderStatus> {
  if (invalidConfig) return { status: 'invalid_config', message: 'The image provider configuration could not be loaded.' };
  if (!provider) return { status: 'unconfigured', message: 'Configure an image provider to start queued jobs.' };
  try {
    if (!provider.checkAvailability || await provider.checkAvailability(AbortSignal.timeout(2_000))) {
      return { status: 'ready', provider: provider.name, message: 'The image provider is reachable.' };
    }
  } catch {
    // Status is safe to expose without endpoint URLs or filesystem details.
  }
  return { status: 'unreachable', provider: provider.name, message: 'The configured image provider did not respond to its health check.' };
}

type JsonObject = Record<string, unknown>;
type WorkflowNode = { class_type: string; inputs: JsonObject };

function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

async function readBounded(response: Response, limit: number) {
  const length = Number(response.headers.get('content-length'));
  if (!response.body) throw new Error('Empty response');
  if (length > limit) {
    await response.body.cancel();
    throw new Error('Response exceeds size limit');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('Response exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function readJson(response: Response) {
  const value: unknown = JSON.parse((await readBounded(response, 4 * 1024 * 1024)).toString('utf8'));
  const result = object(value);
  if (!result) throw new Error('Provider response must be an object');
  return result;
}

export interface ComfyProviderSettings {
  url: string;
  workflow: unknown;
  promptNode: string;
  outputNode: string;
}

export function createComfyProvider({ url, workflow, promptNode, outputNode }: ComfyProviderSettings): MediaProvider {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('STH_COMFY_URL must be an HTTP(S) base URL without credentials, query, or fragment.');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/`;
  const graph = object(structuredClone(workflow));
  const nodes = new Map<string, WorkflowNode>();
  for (const [id, entry] of Object.entries(graph ?? {})) {
    const node = object(entry);
    const inputs = object(node?.inputs);
    if (typeof node?.class_type !== 'string' || !inputs) throw new Error('Supply a ComfyUI API prompt graph.');
    if (typeof inputs.batch_size === 'number' && inputs.batch_size !== 1) {
      throw new Error('The ComfyUI workflow must generate one image per prompt.');
    }
    nodes.set(id, { class_type: node.class_type, inputs });
  }
  if (typeof nodes.get(promptNode)?.inputs.text !== 'string') {
    throw new Error('STH_COMFY_PROMPT_NODE must identify an API node with a literal text input.');
  }
  const imageOutputs = [...nodes].filter(([, node]) => ['SaveImage', 'PreviewImage'].includes(node.class_type));
  if (imageOutputs.length !== 1 || imageOutputs[0][0] !== outputNode) {
    throw new Error('STH_COMFY_OUTPUT_NODE must identify the graph\'s single SaveImage or PreviewImage node.');
  }

  const template = JSON.stringify(graph);
  const parameters: ProviderParameters = { workflowSha256: sha256(template), promptNode, outputNode };
  const reportedInputs = ['ckpt_name', 'unet_name', 'clip_name', 'vae_name', 'seed', 'noise_seed', 'steps', 'cfg',
    'sampler_name', 'scheduler', 'width', 'height', 'denoise'];
  for (const [id, { inputs }] of nodes) {
    for (const input of reportedInputs) {
      const value = inputs[input];
      if (typeof value === 'number' && Number.isFinite(value)) parameters[`${id}.${input}`] = value;
      if (typeof value === 'string' && value.length <= 300) parameters[`${id}.${input}`] = value;
    }
  }

  const request = (path: string, signal: AbortSignal, init?: RequestInit) =>
    fetch(new URL(path, endpoint), { ...init, signal, redirect: 'error' });

  return {
    name: 'comfyui', key: `comfyui:${sha256(endpoint.href)}`, parameters: Object.freeze(parameters),
    async checkAvailability(signal) {
      const response = await request('system_stats', signal);
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      return typeof object((await readJson(response)).system)?.comfyui_version === 'string';
    },
    async submit({ requestId, prompt }, signal) {
      const input = JSON.parse(template) as Record<string, WorkflowNode>;
      input[promptNode].inputs.text = prompt;
      const response = await request('prompt', signal, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: input, prompt_id: requestId, extra_data: { sth_request_id: requestId } }),
      });
      const data = await readJson(response);
      const error = object(data.error);
      if (response.status === 400 && typeof error?.type === 'string' && object(data.node_errors)) {
        const type = /^[a-z_]{1,64}$/.test(error.type) ? error.type : 'workflow_validation_error';
        return { state: 'failed', message: `ComfyUI rejected the workflow (${type}).` };
      }
      if (response.ok && typeof data.prompt_id === 'string' && /^[\w-]{1,128}$/.test(data.prompt_id)) {
        return { state: 'submitted', providerJobId: data.prompt_id };
      }
      return { state: 'unknown', message: `ComfyUI returned an unconfirmed submission response (HTTP ${response.status}).` };
    },
    async lookup({ requestId, providerJobId, parameters: original }, signal) {
      const id = providerJobId ?? requestId;
      const readHistory = async () => {
        const response = await request(`history/${encodeURIComponent(id)}`, signal);
        if (!response.ok) throw new Error('Could not read ComfyUI history');
        return object((await readJson(response))[id]);
      };
      let history = await readHistory();
      if (!history) {
        const response = await request('queue', signal);
        if (!response.ok) throw new Error('Could not read ComfyUI queue');
        const queue = await readJson(response);
        if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) {
          throw new Error('Invalid ComfyUI queue response');
        }
        if ([...queue.queue_running, ...queue.queue_pending].some(entry => Array.isArray(entry) && entry[1] === id
          && object(entry[3])?.sth_request_id === requestId)) {
          return { state: 'submitted', providerJobId: id };
        }
        // A running prompt can move into history between the two reads.
        history = await readHistory();
      }
      if (!history || !Array.isArray(history.prompt) || object(history.prompt[3])?.sth_request_id !== requestId) {
        return { state: 'unknown', message: 'The request was not found in ComfyUI queue/history. Absence does not confirm failure.' };
      }
      const status = object(history.status);
      if (status?.status_str === 'error') {
        return { state: 'failed', providerJobId: id, message: 'ComfyUI recorded a terminal execution error. Check its history before retrying.' };
      }
      if (status?.status_str !== 'success' || status.completed !== true) {
        return { state: 'unknown', providerJobId: id, message: 'ComfyUI history has no confirmed terminal result.' };
      }
      const imageNode = typeof original.outputNode === 'string' ? object(object(history.outputs)?.[original.outputNode]) : undefined;
      const image = Array.isArray(imageNode?.images) && imageNode.images.length === 1 ? object(imageNode.images[0]) : undefined;
      if (typeof image?.filename !== 'string' || typeof image.subfolder !== 'string' || (image.type !== 'output' && image.type !== 'temp')) {
        return { state: 'unknown', providerJobId: id, message: 'ComfyUI completed the prompt without a single readable image at the configured output node.' };
      }
      const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
      const response = await request(`view?${query}`, signal);
      if (!response.ok) {
        await response.body?.cancel();
        return { state: 'unknown', providerJobId: id, message: 'ComfyUI completed the prompt, but the image could not be downloaded.' };
      }
      try {
        return { state: 'succeeded', providerJobId: id, bytes: await readBounded(response, maxImageBytes) };
      } catch {
        return { state: 'unknown', providerJobId: id, message: 'The ComfyUI image download was incomplete or exceeded the storage limit.' };
      }
    },
  };
}

export function createMediaProviderFromEnv(env: NodeJS.ProcessEnv = process.env): MediaProvider | undefined {
  const { STH_COMFY_URL: url, STH_COMFY_WORKFLOW: file, STH_COMFY_PROMPT_NODE: promptNode, STH_COMFY_OUTPUT_NODE: outputNode } = env;
  if (!url && !file && !promptNode && !outputNode) return undefined;
  if (!url || !file || !promptNode || !outputNode) {
    throw new Error('Set STH_COMFY_URL, STH_COMFY_WORKFLOW, STH_COMFY_PROMPT_NODE and STH_COMFY_OUTPUT_NODE together.');
  }
  return createComfyProvider({ url, workflow: JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), promptNode, outputNode });
}
