import { isDeepStrictEqual } from 'node:util';

// JSON.parse validates the syntax. This small span reader preserves every byte
// outside the selected server value, including indentation and other entries.
function spans(text) {
  try { JSON.parse(text); } catch { throw new Error('The selected configuration must contain strict valid JSON.'); }
  let i = 0;
  const whitespace = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i++] === '"') break;
      if (text[i - 1] === '\\') i++;
    }
    return JSON.parse(text.slice(start, i));
  }
  function value() {
    whitespace();
    const start = i;
    const type = text[i];
    const entries = new Map();
    if (type === '{') {
      i++;
      whitespace();
      while (text[i] !== '}') {
        const key = string();
        if (entries.has(key)) throw new Error('Duplicate JSON keys require manual repair before installation.');
        whitespace(); i++; // colon
        entries.set(key, value());
        whitespace();
        if (text[i] !== ',') break;
        i++; whitespace();
      }
      i++;
    } else if (type === '[') {
      i++; whitespace();
      while (text[i] !== ']') {
        value(); whitespace();
        if (text[i] !== ',') break;
        i++;
      }
      i++;
    } else if (type === '"') string();
    else while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
    return { start, end: i, type, entries };
  }
  return value();
}

function put(text, object, name, value) {
  if (object.type !== '{') throw new Error('MCP configuration and mcpServers must be JSON objects.');
  const existing = object.entries.get(name);
  if (existing) return text.slice(0, existing.start) + JSON.stringify(value, null, 2) + text.slice(existing.end);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const baseIndent = text.slice(text.lastIndexOf('\n', object.start) + 1, object.start).match(/^\s*/)[0];
  const serialized = JSON.stringify(value, null, 2).replaceAll('\n', eol + baseIndent + '  ');
  const insertion = `${object.entries.size ? ',' : ''}${eol}${baseIndent}  ${JSON.stringify(name)}: ${serialized}${eol}${baseIndent}`;
  const tail = text.slice(object.start + 1, object.end - 1).match(/\s*$/)[0].length;
  const position = object.end - 1 - tail;
  return text.slice(0, position) + insertion + text.slice(object.end - 1);
}

export function updateAntigravityConfig(text, name, entry, replace = false) {
  const root = spans(text);
  if (root.type !== '{') throw new Error('MCP configuration must be a JSON object.');
  const object = root.entries.get('mcpServers');
  if (!object) return put(text, root, 'mcpServers', { [name]: entry });
  if (object.type !== '{') throw new Error('mcpServers must be a JSON object.');
  const previous = object.entries.get(name);
  if (previous) {
    const stored = JSON.parse(text.slice(previous.start, previous.end));
    if (isDeepStrictEqual(stored, entry)) return text;
    if (!replace) throw new Error('The selected MCP entry already exists. Review it and pass --replace to change it.');
  }
  return put(text, object, name, entry);
}
