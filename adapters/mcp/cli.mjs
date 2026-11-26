#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openBinding, pair } from './credentials.mjs';
import { request } from './http.mjs';

const names = { catalog: 'sth_personal_discover', invoke: 'sth_personal_invoke', receipt: 'sth_personal_receipt' };
const prefix = 'sth.mcp.v1:';
const maxStep = 512 - prefix.length;
const operation = '^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)*$';
const operationIdPattern = new RegExp(operation);
const lookupProperties = {
  operationId: { type: 'string', maxLength: 100, pattern: operation },
  stepId: { type: 'string', minLength: 1, maxLength: maxStep, pattern: '^[^\\s\\x00-\\x1f\\x7f]+$' },
};

function schema(properties) {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
}

const tools = [
  { name: names.catalog, description: 'List the operation index, then request the full schema by operationId or domain prefix.',
    inputSchema: { ...schema({ view: { type: 'string', enum: ['index', 'full'] }, prefix: { type: 'string' }, operationId: lookupProperties.operationId }), required: [] } },
  {
    name: names.invoke,
    description: 'Invoke a discovered operation. Use a stable event ID and logical step in stepId. Reuse the same stepId and input on retry. Use a complete ISO date for date fields. For a generation prompt, discover generations.prompt.page and follow its cursors for the complete messages or provenance.',
    inputSchema: schema({ ...lookupProperties, input: {} }),
  },
  {
    name: names.receipt,
    description: 'Read a saved result given the operationId and original caller stepId used with invoke.',
    inputSchema: schema(lookupProperties),
  },
];

function lookup(args, withInput) {
  const { operationId, stepId } = args;
  if (Object.keys(args).length !== (withInput ? 3 : 2) || (withInput && !Object.hasOwn(args, 'input'))
      || typeof operationId !== 'string' || operationId.length > 100 || !operationIdPattern.test(operationId)
      || typeof stepId !== 'string' || stepId.length < 1 || stepId.length > maxStep || /[\s\x00-\x1f\x7f]/.test(stepId)) {
    return null;
  }
  return { operationId, stepId: prefix + stepId, ...(withInput ? { input: args.input } : {}) };
}

function toolResult(value, token, failed = false) {
  const text = JSON.stringify(value).replaceAll(token, '[redacted]');
  const content = [{ type: 'text', text }];
  return failed ? { isError: true, content } : { content, structuredContent: JSON.parse(text) };
}

async function serve(path) {
  const { origin, token } = await openBinding(path);
  const server = new Server({ name: 'sth-personal-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments ?? {};
    let endpoint;
    let body;
    if (params.name === names.catalog && Object.keys(args).every(key => ['view', 'prefix', 'operationId'].includes(key))) {
      endpoint = 'catalog';
      body = Object.keys(args).length ? args : { view: 'index' };
    } else if (params.name === names.invoke || params.name === names.receipt) {
      endpoint = params.name === names.invoke ? 'invoke' : 'receipt';
      body = lookup(args, endpoint === 'invoke');
    }
    if (!body) return toolResult({ error: 'invalid_tool_call', message: 'Invalid Sth operation tool call.' }, token, true);
    try {
      const { status, value } = await request(origin, endpoint, body, token);
      if (status === 401) {
        return toolResult({ error: 'connection_unauthorized', message: 'Pair again with a fresh Sth connection code.' }, token, true);
      }
      if (status < 200 || status >= 300) {
        return toolResult({
          error: typeof value.error === 'string' ? value.error : 'sth_http_error',
          message: typeof value.message === 'string' ? value.message : `Sth request failed (${status}).`,
          retryable: status >= 500,
          ...(Number.isSafeInteger(value.currentRevision) ? { currentRevision: value.currentRevision } : {}),
        }, token, true);
      }
      const valid = endpoint === 'catalog' ? Array.isArray(value.operations)
        : value.operationId === body.operationId && value.stepId === body.stepId && typeof value.replayed === 'boolean'
          && (endpoint !== 'receipt' || value.replayed) && Object.hasOwn(value, 'result');
      if (!valid) throw new Error('Invalid operation envelope.');
      return toolResult(value, token);
    } catch {
      return toolResult({ error: 'sth_unavailable', message: 'Sth is unavailable or returned an invalid response.', retryable: true }, token, true);
    }
  });
  await server.connect(new StdioServerTransport());
}

const args = process.argv.slice(2);
try {
  if (args[0] === 'pair' && args.length === 2) {
    process.stdout.write(`${JSON.stringify(await pair(args[1]))}\n`);
  } else if (args[0] === 'stdio' && args.length <= 2) {
    await serve(args[1]);
  } else {
    throw new Error('Usage: node mcp/cli.mjs pair NEW_PRIVATE_DIRECTORY | stdio [BINDING_FILE]');
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
