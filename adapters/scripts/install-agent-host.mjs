#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { installHost } from '../mcp/hosts.mjs';

try {
  const { values } = parseArgs({ options: {
    host: { type: 'string' }, config: { type: 'string' }, binding: { type: 'string' }, workspace: { type: 'string' },
    'source-id': { type: 'string' }, name: { type: 'string' }, replace: { type: 'boolean', default: false },
    executable: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('Usage: node adapters/scripts/install-agent-host.mjs --host antigravity|codex --config ABSOLUTE_FILE --binding ABSOLUTE_FILE --workspace ABSOLUTE_DIRECTORY [--source-id ID] [--name sth-personal] [--replace] [--executable HOST_CLI]\n');
  } else {
    process.stdout.write(`${JSON.stringify(await installHost({ ...values, sourceId: values['source-id'] }))}\n`);
  }
} catch (error) {
  // Parser errors can embed the supplied argument. Never reflect arbitrary CLI
  // values, which could accidentally contain a connection code or a token.
  process.stderr.write(`${error.code?.startsWith('ERR_PARSE_ARGS') ? 'Invalid installer arguments. Run with --help.' : error.message}\n`);
  process.exitCode = 1;
}
