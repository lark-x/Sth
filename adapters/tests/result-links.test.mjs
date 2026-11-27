import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { linkText, portalOrigin, resultLink } from '../mcp/result-links.mjs';
import { serviceOrigin } from '../mcp/http.mjs';

const token = 'fixture-token';
const fields = { hrefField: 'href', labelField: 'title', revisionField: 'revision' };
const routes = ['diaries', 'drafts', 'sources', 'generations'];
const value = { href: '/diaries/note-1', title: '普通日记', revision: 3 };
const cases = [
  { name: 'ordinary diary', value, expected: { path: '/diaries/note-1?revision=3', label: '普通日记' } },
  { name: 'draft ID uses its own revision', value: { ...value, href: '/drafts/draft-1', sceneRevision: 9 },
    expected: { path: '/drafts/draft-1?revision=3', label: '普通日记' } },
  { name: 'available UTF-16 range', value: { ...value, href: '/sources/source-1?revision=3', context: { range: { start: 4, end: 8 } } },
    fields: { ...fields, rangeField: 'context.range' }, expected: { path: '/sources/source-1?revision=3&start=4&end=8', label: '普通日记' } },
  { name: 'no invented range from repeated text', value: { ...value, body: '同一句。同一句。', excerpt: '同一句' },
    fields: { ...fields, rangeField: 'context.range' }, expected: { path: '/diaries/note-1?revision=3', label: '普通日记' } },
  { name: 'existing canonical range', value: { ...value, href: '/drafts/draft-1?revision=3&start=0&end=2' },
    expected: { path: '/drafts/draft-1?revision=3&start=0&end=2', label: '普通日记' } },
  { name: 'legacy result link', fields: { hrefField: 'href', labelField: 'title' },
    value: { href: '/generations/g-1/result', title: 'Existing result', revision: 9 },
    expected: { path: '/generations/g-1/result', label: 'Existing result' } },
  { name: 'label redaction', value: { ...value, title: `  第一行\n${token}  ` },
    expected: { path: '/diaries/note-1?revision=3', label: '第一行 [redacted]' } },
  { name: 'Unicode label truncation', value: { ...value, title: '🌙'.repeat(301) },
    expected: { path: '/diaries/note-1?revision=3', label: '🌙'.repeat(300) } },
  ...['https://elsewhere.test/diaries/note-1', '//elsewhere.test/diaries/note-1', '/diaries/../note-1',
    '/diaries/note-1#edit', '/diaries/note-1?revision=3&revision=4', '/diaries/note-1?revision=3&token=secret',
    '/diaries/note-1?revision=0', '/diaries/note-1?revision=9007199254740992', '/diaries/note-1?revision=2',
    '/diaries/note-1?revision=3&start=2&end=2', '/diaries/note-1?revision=3&start=0&end=100001',
    '/diaries/note-1?start=0&end=2', '/diaries/note-1?revision=3&start=00&end=2',
    '/diaries/note-1\n', '/diaries/fixture-token', '/connections/note-1'].map(href => ({ name: href, value: { ...value, href } })),
  ...[0, -1, true, '3', null, 9007199254740992].map(revision => ({ name: `invalid revision ${revision}`, value: { ...value, revision } })),
  ...[null, { start: -1, end: 2 }, { start: true, end: 2 }, { start: 1, end: 1 }, { start: 0, end: 100001 }].map(range => ({
    name: `invalid range ${JSON.stringify(range)}`, value: { ...value, context: { range } }, fields: { ...fields, rangeField: 'context.range' },
  })),
  { name: 'unlisted resource', value, routes: [] },
  { name: 'undeclared link', value, fields: null },
];

test('declared result links preserve document identity, exact revisions and available ranges', () => {
  for (const item of cases) {
    assert.deepEqual(resultLink(item.value, Object.hasOwn(item, 'fields') ? item.fields : fields, item.routes ?? routes, token), item.expected, item.name);
  }
  assert.equal(linkText({ label: '稿件 [一] \\ 二', url: 'https://sth.test/drafts/d-1?revision=3' }),
    '[稿件 \\[一\\] \\\\ 二](https://sth.test/drafts/d-1?revision=3)');
});

test('Hermes and MCP use the same result-link cases', {
  skip: !process.env.STH_TEST_HERMES_PYTHON && 'Set STH_TEST_HERMES_PYTHON to check the Python implementation',
}, async () => {
  const script = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('result_links', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cases, fields, routes, token = json.loads(sys.argv[2])
print(json.dumps([module.result_link(item['value'], item.get('fields', fields), item.get('routes', routes), token) for item in cases], ensure_ascii=True))`;
  const { stdout } = await promisify(execFile)(process.env.STH_TEST_HERMES_PYTHON, ['-B', '-c', script,
    fileURLToPath(new URL('../hermes_plugin/result_links.py', import.meta.url)), JSON.stringify([cases, fields, routes, token])]);
  assert.deepEqual(JSON.parse(stdout), cases.map(item => item.expected ?? null));
});

test('portal origins allow explicit HTTPS and private LAN display without expanding API origins', () => {
  for (const [origin, expected] of [
    ['https://STH.example.test:443/', 'https://sth.example.test'],
    ['http://192.168.1.20:9321', 'http://192.168.1.20:9321'],
    ['http://10.1.2.3', 'http://10.1.2.3'], ['http://172.16.2.3', 'http://172.16.2.3'],
    ['http://sth.local:9321', 'http://sth.local:9321'], ['http://[fd00::1]:9321', 'http://[fd00::1]:9321'],
  ]) assert.equal(portalOrigin(origin), expected, origin);
  for (const origin of ['http://public.example.test', 'http://172.32.1.2', 'http://127.0.0.1:9321', 'https://localhost',
    'http://[::1]:9321', 'http://localhost.local', 'https://user@sth.test', 'https://sth.test/path',
    'https://sth.test?token=secret', 'https://sth.test#fragment', 'https://sth.test:0', 'https://sth.test\\elsewhere',
    'javascript:alert(1)', 'file:///tmp/sth', 'https://sth.test\n']) assert.equal(portalOrigin(origin), undefined, origin);
  assert.throws(() => serviceOrigin('http://192.168.1.20:9321'));
});
