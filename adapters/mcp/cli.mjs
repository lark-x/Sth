#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openBinding, pair } from './credentials.mjs';
import { request } from './http.mjs';
import { linkText, portalOrigin, resultLink } from './result-links.mjs';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

const names = { catalog: 'sth_personal_discover', invoke: 'sth_personal_invoke', receipt: 'sth_personal_receipt' };
const prefix = 'sth.mcp.v1:';
const maxStep = 512 - prefix.length;
const operation = '^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)*$';
const operationIdPattern = new RegExp(operation);
const lookupProperties = {
  operationId: { type: 'string', maxLength: 100, pattern: operation, description: 'Exact discovered operation ID, for example source.read.' },
  stepId: { type: 'string', minLength: 1, maxLength: maxStep, pattern: '^[^\\s\\x00-\\x1f\\x7f]+$',
    description: 'Required top-level caller step identifier. Use a different value for each logical operation and reuse it only for an identical retry.' },
};

function schema(properties) {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
}

const tools = [
  { name: names.catalog, description: 'Call with {} for the operation index. Call with {"operationId":"source.read"} for one full schema, or {"view":"full","prefix":"source."} for a domain. Only view, prefix, and operationId are accepted. Fetch individual schemas when the full index is too large.',
    inputSchema: { ...schema({ view: { type: 'string', enum: ['index', 'full'] }, prefix: { type: 'string' }, operationId: lookupProperties.operationId }), required: [] } },
  {
    name: names.invoke,
    description: 'Invoke a discovered operation with exactly three top-level fields operationId, stepId, and input. Example {"operationId":"source.read","stepId":"read-source-1","input":{"sourceId":"the-source-id"}}. Discover the operation schema before invoking it. Use distinct stepId values for different operations and reuse the same stepId and input on an identical retry. Use a complete ISO date for date fields. Show the returned portalUrl or rendered link for a saved manuscript and its exact revision and available selection. For a generation prompt, discover generations.prompt.page and follow its cursors for the complete messages or provenance.',
    inputSchema: schema({ ...lookupProperties, input: { description: 'The operation input value matching its discovered inputSchema.' } }),
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

function toolResult(value, token, failed = false, link) {
  const text = JSON.stringify(value).replaceAll(token, '[redacted]');
  const content = [{ type: 'text', text }];
  if (link) content.push({ type: 'text', text: linkText(link) });
  return failed ? { isError: true, content } : { content, structuredContent: JSON.parse(text) };
}

async function serve(path, { workspace, sourceId } = {}) {
  const { origin, token } = await openBinding(path);
  const portal = portalOrigin() || origin;
  if (workspace) {
    if (!isAbsolute(workspace) || !(await stat(workspace)).isDirectory()) throw new Error('Supply an absolute local workspace directory.');
    process.chdir(workspace);
  }
  if (sourceId) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(sourceId)) throw new Error('Supply a valid selected source ID.');
    tools[0] = { ...tools[0], description: `${tools[0].description} Selected Sth sourceId is ${JSON.stringify(sourceId)}. Discover source.read, then read this sourceId without revision for the latest version. This selection is context, and the connection retains its personal catalog access.` };
  }
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
    if (!body) return toolResult({ error: 'invalid_tool_call',
      message: tools.find(tool => tool.name === params.name)?.description || 'Unknown Sth tool.' }, token, true);
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
      let link;
      if (endpoint !== 'catalog') {
        // Link presentation must not turn a saved operation into a failed invocation.
        try {
          const catalog = await request(origin, 'catalog', { operationId: body.operationId }, token);
          const descriptor = catalog.status === 200 && catalog.value.operations?.find(item => item.id === body.operationId);
          const target = resultLink(value.result, descriptor?.interaction?.resultLink, catalog.value.resourcePaths, token);
          if (target && !(portal + target.path).includes(token)) {
            link = { label: target.label, url: portal + target.path };
            value.result.portalUrl = link.url;
          }
        } catch { /* Keep the successful operation envelope when link metadata is unavailable. */ }
      }
      return toolResult(value, token, false, link);
    } catch {
      return toolResult({ error: 'sth_unavailable', message: 'Sth is unavailable or returned an invalid response.', retryable: true }, token, true);
    }
  });
  await server.connect(new StdioServerTransport());
}

const args = process.argv.slice(2);
try {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'client-name': { type: 'string' }, workspace: { type: 'string' }, 'source-id': { type: 'string' },
  } });
  if (positionals[0] === 'pair' && positionals.length === 2 && !values.workspace && !values['source-id']) {
    process.stdout.write(`${JSON.stringify(await pair(positionals[1], { clientName: values['client-name'] }))}\n`);
  } else if (positionals[0] === 'stdio' && positionals.length <= 2 && !values['client-name']) {
    await serve(positionals[1], { workspace: values.workspace, sourceId: values['source-id'] });
  } else {
    throw new Error('Usage: node mcp/cli.mjs pair NEW_PRIVATE_DIRECTORY [--client-name NAME] | stdio [BINDING_FILE] [--workspace DIRECTORY] [--source-id ID]');
  }
} catch (error) {
  process.stderr.write(`${error.code?.startsWith('ERR_PARSE_ARGS') ? 'Invalid MCP arguments.' : error.message}\n`);
  process.exitCode = 1;
}
