import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

// Node's native TypeScript loader excludes installed dependencies. Handle only
// this package's own source when Sth is installed beneath node_modules.
if (sourceRoot.split(sep).includes('node_modules')) {
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);
      const path = fileURLToPath(url);
      if (!path.startsWith(sourceRoot)) return nextLoad(url, context);
      return {
        format: 'module',
        source: stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip', sourceUrl: url }),
        shortCircuit: true,
      };
    },
  });
}
