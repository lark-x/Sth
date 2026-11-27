import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseVue } from '@vue/compiler-sfc';
import { NodeTypes, parse as parseHtml } from '@vue/compiler-dom';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const worktree = root.split(sep).join('/');
const savedPath = join(root, 'docs/architecture-baseline.json');
const roots = ['src', 'frontend', 'web', 'adapters', 'scripts'];
const rootInputs = ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts'];
const scripts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const formats = new Set([...scripts, '.vue', '.py', '.ps1', '.css', '.html', '.svg', '.json', '.yaml', '.yml']);
const skippedDirectories = new Set(['vendor', 'dist', 'node_modules', '.artifacts', 'artifacts', 'coverage', '__pycache__', 'fixtures', '__fixtures__']);
const cloneTokens = 80;
const cloneLines = 5;
const hotspotScore = 12;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const byJson = (left, right) => compareText(JSON.stringify(left), JSON.stringify(right));
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => hash(JSON.stringify(stable(value)));

function run(command, args, { input, optional = false, shell = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, input, shell, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (optional && result.error?.code === 'ENOENT') return undefined;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

function sources() {
  const names = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots]).split('\0');
  const excluded = {};
  const files = [];
  for (const file of [...new Set(names.filter(Boolean))].sort()) {
    const extension = posix.extname(file);
    const parts = file.split('/');
    const stat = lstatSync(join(root, file), { throwIfNoEntry: false });
    const reason = !stat?.isFile() ? 'missingOrNonRegular' : parts.slice(1, -1).some(part => skippedDirectories.has(part))
      ? 'generatedOrVendoredDirectory' : !formats.has(extension) ? 'outsideSourceFormats' : null;
    if (reason) {
      if (stat) excluded[reason] = (excluded[reason] ?? 0) + 1;
      continue;
    }
    const bytes = readFileSync(join(root, file));
    const kind = parts.includes('tests') || /(?:^|\.)test\.[^.]+$/.test(parts.at(-1)) ? 'test' : 'source';
    files.push({ file, extension, kind, bytes: bytes.length, sha256: hash(bytes), text: bytes.toString('utf8') });
  }
  return { files, excluded };
}

function jsImports(node, imports, line, column) {
  const add = (type, specifier) => imports.push([type, specifier, line, column]);
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    if (node.moduleSpecifier) add(node.isTypeOnly || node.importClause?.isTypeOnly ? 'type' : 'static', node.moduleSpecifier.text);
  } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
    add('type', node.argument.literal.text);
  } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    add(node.isTypeOnly ? 'type' : 'static', node.moduleReference.expression?.text ?? null);
  } else if (ts.isCallExpression(node)) {
    const loader = node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic'
      : ts.isIdentifier(node.expression) && node.expression.text === 'require' ? 'require' : null;
    if (loader) add(loader, node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : null);
  }
}

const branchKinds = new Set([ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.CatchClause, ts.SyntaxKind.ConditionalExpression]);
const logicalKinds = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

function jsRegion(file, text, offset, language, firstColumn = 1) {
  const source = ts.createSourceFile(`input.${language}`, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`${file}:${offset + 1} ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, '\n')}`);
  const imports = [];
  const scopes = [{ name: '<module>', line: offset + 1, score: 0 }];
  const tokens = [];
  const location = position => {
    const { line, character } = source.getLineAndCharacterOfPosition(position);
    return [offset + 1 + line, (line === 0 ? firstColumn : 1) + character];
  };
  function visit(node, depth, scope) {
    const [line, column] = location(node.getStart(source));
    if (ts.isFunctionLike(node) && node.body) {
      scope = { name: node.name?.getText(source) ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(source) : '<anonymous>'), line, score: 0 };
      scopes.push(scope);
      depth = 0;
    }
    jsImports(node, imports, line, column);
    if (ts.isBinaryExpression(node) && logicalKinds.has(node.operatorToken.kind)) scope.score += 1;
    if (branchKinds.has(node.kind)) {
      scope.score += 1 + depth;
      depth += 1;
    }
    ts.forEachChild(node, child => visit(child, depth, scope));
  }
  function lex(node) {
    const children = node.getChildren(source);
    if (children.length) children.forEach(lex);
    else if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken && node.getWidth(source) > 0) {
      tokens.push([`${node.kind}:${node.getText(source)}`, location(node.getStart(source))[0], location(node.end - 1)[0]]);
    }
  }
  visit(source, 0, scopes[0]);
  lex(source);
  return { imports, scopes, tokens };
}

const pythonCollector = String.raw`
import ast, io, json, sys, tokenize

def inspect(text):
    tree = ast.parse(text)
    imports, scopes = [], [dict(name='<module>', line=1, score=0)]
    branches = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Match, ast.ExceptHandler, ast.IfExp)
    functions = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)

    def visit(node, depth, scope):
        if isinstance(node, functions):
            scope = dict(name=getattr(node, 'name', '<anonymous>'), line=node.lineno, score=0)
            scopes.append(scope)
            depth = 0
        if isinstance(node, ast.Import):
            imports.extend([alias.name, 0, [], node.lineno, node.col_offset + 1] for alias in node.names)
        if isinstance(node, ast.ImportFrom):
            imports.append([node.module or '', node.level, [alias.name for alias in node.names], node.lineno, node.col_offset + 1])
        if isinstance(node, ast.BoolOp):
            scope['score'] += len(node.values) - 1
        if isinstance(node, branches):
            scope['score'] += 1 + depth
            depth += 1
        for child in ast.iter_child_nodes(node):
            visit(child, depth, scope)

    visit(tree, 0, scopes[0])
    ignored = {tokenize.COMMENT, tokenize.NL, tokenize.ENDMARKER, tokenize.ENCODING}
    structural = {tokenize.INDENT, tokenize.DEDENT, tokenize.NEWLINE}
    tokens = [[tokenize.tok_name[t.type] + ':' + ('' if t.type in structural else t.string), t.start[0], t.end[0]]
              for t in tokenize.generate_tokens(io.StringIO(text).readline) if t.type not in ignored]
    return dict(imports=imports, scopes=scopes, tokens=tokens)

results = {}
for path, text in json.load(sys.stdin).items():
    try:
        results[path] = inspect(text)
    except (SyntaxError, tokenize.TokenError) as error:
        raise ValueError(f'{path}: {error}') from error
print(json.dumps(results))
`;

function pythonRegions(files) {
  if (!files.length) return {};
  const input = JSON.stringify(Object.fromEntries(files.map(({ file, text }) => [file, text])));
  const args = ['-X', 'utf8', '-c', pythonCollector];
  const options = { input, optional: true };
  const output = process.platform === 'win32'
    ? run('py', ['-3', ...args], options) ?? run('python', args, options)
    : run('python3', args, options);
  if (output === undefined) throw new Error('Python 3 is required to analyze the Python sources.');
  return JSON.parse(output);
}

function jsBase(from, specifier) {
  return specifier.startsWith('.') ? posix.join(posix.dirname(from), specifier)
    : specifier.startsWith('/frontend/') ? specifier.slice(1)
    : specifier.startsWith('/assets/') ? `web${specifier}` : null;
}

function jsTarget(base, names) {
  const substitute = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts', '.jsx': '.tsx' }[posix.extname(base)];
  const candidates = [base, ...(substitute ? [base.slice(0, -posix.extname(base).length) + substitute] : []),
    ...['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json', '.vue'].flatMap(extension => [base + extension, `${base}/index${extension}`])];
  return candidates.find(candidate => names.has(candidate)) ?? null;
}

function pythonTargets(file, module, level, members, names) {
  const folder = posix.dirname(file);
  const relative = posix.join(folder, ...Array(Math.max(0, level - 1)).fill('..'));
  const modulePath = module.replaceAll('.', '/');
  const bases = level ? [posix.join(relative, modulePath)] : [posix.join(folder, modulePath), modulePath];
  const targets = new Set();
  for (const base of bases) {
    const candidates = members.filter(member => member !== '*').map(member => posix.join(base, member));
    if (module || members.includes('*')) candidates.unshift(base);
    for (const candidate of candidates) {
      const target = [`${candidate}.py`, `${candidate}/__init__.py`].find(name => name !== file && names.has(name));
      if (target) targets.add(target);
    }
    if (targets.size) break;
  }
  return [...targets].sort();
}

function analyze(files) {
  const names = new Set(files.map(({ file }) => file));
  const python = pythonRegions(files.filter(({ extension }) => extension === '.py'));
  const edges = [];
  const unresolved = [];
  const inventory = [];
  const tokenStreams = [];
  for (const { file, extension, kind, bytes, sha256, text } of files) {
    const record = { file, kind, format: extension.slice(1), bytes, sha256, analysis: [] };
    inventory.push(record);
    const regions = [];
    const link = (type, specifier, line, column) => {
      if (specifier === null) {
        unresolved.push({ file, type, specifier, line, column, reason: 'computed' });
        return;
      }
      const base = jsBase(file, specifier);
      if (base === null) return;
      const target = jsTarget(base, names);
      if (target) edges.push({ from: file, to: target, type, line, column });
      else unresolved.push({ file, type, specifier, line, column, reason: roots.includes(base.split('/')[0]) ? 'unresolved-local' : 'outside-roots' });
    };
    if (scripts.includes(extension)) {
      regions.push(jsRegion(file, text, 0, extension.startsWith('.m') || extension.startsWith('.c') ? extension.slice(2) : extension.slice(1)));
    } else if (extension === '.vue') {
      const { descriptor, errors } = parseVue(text, { filename: file, sourceMap: false });
      if (errors.length) throw new Error(`${file}: ${errors.map(error => error.message ?? error).join('; ')}`);
      for (const block of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
        if (block.src) link('embedded', block.src, block.loc.start.line, block.loc.start.column);
        else regions.push(jsRegion(file, block.content, block.loc.start.line - 1, block.lang ?? 'js', block.loc.start.column));
      }
      for (const block of [descriptor.template, ...descriptor.styles].filter(block => block?.src)) link('embedded', block.src, block.loc.start.line, block.loc.start.column);
    } else if (extension === '.html') {
      record.analysis.push('dependencies');
      function visit(node) {
        const attrs = Object.fromEntries((node.props ?? []).filter(prop => prop.type === NodeTypes.ATTRIBUTE).map(prop => [prop.name, prop.value?.content]));
        if (node.tag === 'script' && attrs.type === 'module' && attrs.src) link('html', attrs.src, node.loc.start.line, node.loc.start.column);
        if (node.tag === 'link' && ['stylesheet', 'icon'].includes(attrs.rel) && attrs.href) link('html', attrs.href, node.loc.start.line, node.loc.start.column);
        if (Array.isArray(node.children)) node.children.forEach(visit);
      }
      visit(parseHtml(text));
    } else if (extension === '.py') {
      regions.push({ ...python[file], imports: [] });
      for (const [module, level, members, line, column] of python[file].imports) {
        const targets = pythonTargets(file, module, level, members, names);
        for (const to of targets) edges.push({ from: file, to, type: 'python', line, column });
        if (level && !targets.length) unresolved.push({ file, type: 'python', specifier: '.'.repeat(level) + module, line, column, reason: 'unresolved-local' });
      }
    }
    if (regions.length) {
      record.analysis.push('complexity', 'dependencies', 'duplicates');
      const scopes = regions.flatMap(region => region.scopes);
      record.complexity = {
        functions: scopes.length - regions.length,
        total: scopes.reduce((sum, scope) => sum + scope.score, 0),
        max: Math.max(...scopes.map(scope => scope.score)),
        hotspots: scopes.filter(scope => scope.score >= hotspotScore),
      };
      for (const region of regions) {
        region.imports.forEach(([type, specifier, line]) => link(type, specifier, line));
        tokenStreams.push({ file, kind, family: extension === '.py' ? 'python' : 'javascript', tokens: region.tokens });
      }
    } else if (extension === '.vue') record.analysis.push('dependencies');
  }
  return { inventory, edges: edges.sort(byJson), unresolved: unresolved.sort(byJson), tokenStreams };
}

function cycles(edges) {
  const graph = new Map();
  for (const { from, to } of edges) {
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from).add(to);
    if (!graph.has(to)) graph.set(to, new Set());
  }
  const seen = new Map();
  const active = new Set();
  const stack = [];
  const result = [];
  function visit(file) {
    const rank = seen.size;
    let low = rank;
    seen.set(file, rank);
    stack.push(file);
    active.add(file);
    for (const to of graph.get(file)) {
      if (!seen.has(to)) low = Math.min(low, visit(to));
      else if (active.has(to)) low = Math.min(low, seen.get(to));
    }
    if (low === rank) {
      const component = [];
      do {
        component.push(stack.pop());
        active.delete(component.at(-1));
      } while (component.at(-1) !== file);
      if (component.length > 1 || graph.get(file).has(file)) result.push(component.sort());
    }
    return low;
  }
  for (const file of graph.keys()) if (!seen.has(file)) visit(file);
  return result.sort(byJson);
}

function duplicates(streams) {
  const windows = new Map();
  const matches = [];
  const ids = new Map();
  const factor = 31;
  let highest = 1;
  for (let count = 1; count < cloneTokens; count += 1) highest = Math.imul(highest, factor);
  for (const stream of streams) {
    const { file, kind, family, tokens } = stream;
    const values = tokens.map(([token]) => {
      if (!ids.has(token)) ids.set(token, ids.size + 1);
      return ids.get(token);
    });
    let rolling = 0;
    for (const value of values.slice(0, cloneTokens)) rolling = Math.imul(rolling, factor) + value | 0;
    for (let start = 0; start + cloneTokens <= values.length; start += 1) {
      if (start) rolling = Math.imul(rolling - Math.imul(values[start - 1], highest), factor) + values[start + cloneTokens - 1] | 0;
      const key = `${kind}:${family}:${rolling}`;
      const candidates = windows.get(key) ?? [];
      for (const [other, previous, previousStart] of candidates) {
        if (other.file === file || (start > 0 && previousStart > 0 && values[start - 1] === previous[previousStart - 1])) continue;
        let length = 0;
        while (start + length < values.length && previousStart + length < previous.length && values[start + length] === previous[previousStart + length]) length += 1;
        if (length < cloneTokens) continue;
        const spans = [[other.file, other.tokens[previousStart][1], other.tokens[previousStart + length - 1][2]],
          [file, tokens[start][1], tokens[start + length - 1][2]]];
        if (spans.some(([, first, last]) => last - first + 1 < cloneLines)) continue;
        matches.push({ kind, family, tokens: length, sha256: digest(tokens.slice(start, start + length).map(([token]) => token)), spans });
      }
      candidates.push([stream, values, start]);
      windows.set(key, candidates);
    }
  }
  return matches.sort((left, right) => right.tokens - left.tokens || byJson(left.spans, right.spans) || compareText(left.sha256, right.sha256));
}

function publicContract() {
  const catalog = JSON.parse(run(process.execPath, ['scripts/contract.ts', '--full']));
  const { schemaVersion, resourcePaths, operations } = catalog;
  return { schemaVersion, resourcePaths, sha256: digest(catalog), operations: operations.map(operation => ({ id: operation.id, effect: operation.effect, sha256: digest(operation) })).sort(byJson) };
}

async function persistence() {
  const { openDatabase } = await import('../src/database.ts');
  const directory = mkdtempSync(join(tmpdir(), 'sth-architecture-'));
  try {
    const db = openDatabase(directory);
    try {
      const applicationId = db.prepare('PRAGMA application_id').get().application_id;
      const userVersion = db.prepare('PRAGMA user_version').get().user_version;
      const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all();
      return {
        applicationId, userVersion, sha256: digest({ applicationId, userVersion, rows }),
        objects: rows.map(({ type, name, tbl_name, sql }) => ({ type, name, table: tbl_name, sha256: digest(sql) })),
        migrationSources: ['src/database.ts', 'src/story/decision-schema.ts'].map(file => ({ file, sha256: hash(readFileSync(join(root, file))) })),
      };
    } finally {
      db.close();
    }
  } finally {
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(join(directory, `sth.sqlite${suffix}`), { force: true });
    rmdirSync(directory);
  }
}

function buildSizes() {
  const outputDir = 'frontend/dist';
  const output = join(root, outputDir);
  if (realpathSync(dirname(output)) !== dirname(output) ||
      (lstatSync(output, { throwIfNoEntry: false }) && realpathSync(output) !== output)) {
    throw new Error(`Expected ${outputDir} to resolve inside this worktree without redirects.`);
  }
  const npmOptions = { shell: true };
  const source = {
    worktree, command: 'npm run build', extraArgs: [],
    npmScript: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.build,
    viteConfig: 'vite.config.ts', outputDir,
    node: process.versions.node, npm: run('npm --version', [], npmOptions).trim(),
    platform: `${process.platform}/${process.arch}`, nodeEnv: process.env.NODE_ENV ?? null,
  };
  run('npm run build', [], npmOptions);
  const files = [];
  for (const entry of readdirSync(output, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const path = join(entry.parentPath, entry.name);
    if (!entry.isFile()) throw new Error(`Unexpected non-file build output: ${path}`);
    const content = readFileSync(path);
    files.push({ file: relative(output, path).split(sep).join('/'), bytes: content.length, sha256: hash(content) });
  }
  if (!files.some(entry => entry.file === 'index.html')) throw new Error(`npm run build did not produce ${outputDir}/index.html.`);
  return { source, bytes: files.reduce((total, file) => total + file.bytes, 0), files: files.sort(byJson) };
}

async function snapshot(includeBuild) {
  const { files, excluded } = sources();
  const { inventory, edges, unresolved, tokenStreams } = analyze(files);
  const inputs = rootInputs.map(file => ({ file, sha256: hash(readFileSync(join(root, file))) }));
  const coverage = {};
  const dependencyGroups = {};
  const group = file => file.startsWith('src/') && file.split('/').length > 2 ? file.split('/').slice(0, 2).join('/') : file.split('/')[0];
  for (const item of inventory) {
    const key = `${item.file.split('/')[0]}/${item.kind}/${item.format}`;
    const counts = coverage[key] ??= { files: 0, bytes: 0, dependencies: 0, complexity: 0, duplicates: 0 };
    counts.files += 1;
    counts.bytes += item.bytes;
    for (const metric of item.analysis) counts[metric] += 1;
  }
  for (const edge of edges) {
    const key = `${group(edge.from)} -> ${group(edge.to)} (${edge.type})`;
    dependencyGroups[key] = (dependencyGroups[key] ?? 0) + 1;
  }
  return {
    version: 1, inputSha256: digest([...inventory.map(({ file, sha256 }) => ({ file, sha256 })), ...inputs]), inputs,
    method: { roots, cloneTokens, cloneLines, hotspotScore }, coverage: { groups: stable(coverage), excluded: stable(excluded) },
    inventory, dependencies: { edges, unresolved, groups: stable(dependencyGroups),
      runtimeCycles: cycles(edges.filter(edge => edge.type !== 'type')), allCycles: cycles(edges) },
    duplicates: duplicates(tokenStreams), contract: publicContract(), persistence: await persistence(),
    ...(includeBuild ? { build: buildSizes() } : {}),
  };
}

function diffRows(before, after, key) {
  const previous = new Map(before.map(item => [key(item), item]));
  const current = new Map(after.map(item => [key(item), item]));
  return {
    added: [...current].filter(([id]) => !previous.has(id)).map(([, item]) => item),
    removed: [...previous].filter(([id]) => !current.has(id)).map(([, item]) => item),
    changed: [...current].filter(([id, item]) => previous.has(id) && digest(item) !== digest(previous.get(id)))
      .map(([id, item]) => ({ before: previous.get(id), after: item })),
  };
}

function compare(before, after) {
  if (before.version !== after.version) throw new Error('Baseline format differs. Regenerate the reference with the same analyzer version.');
  const { build: beforeBuild, ...beforeStatic } = before;
  const { build: afterBuild, ...afterStatic } = after;
  const change = (left, right) => digest(left) === digest(right) ? null : { before: left, after: right };
  const json = item => JSON.stringify(item);
  const dependencies = {};
  for (const field of ['edges', 'unresolved', 'runtimeCycles', 'allCycles']) dependencies[field] = diffRows(before.dependencies[field], after.dependencies[field], json);
  const build = afterBuild ? {
    status: 'compared', source: change(beforeBuild.source, afterBuild.source), bytes: change(beforeBuild.bytes, afterBuild.bytes),
    ...diffRows(beforeBuild.files, afterBuild.files, item => item.file),
  } : { status: 'skipped' };
  return {
    stale: digest(beforeStatic) !== digest(afterStatic) || Boolean(afterBuild && digest(beforeBuild) !== digest(afterBuild)),
    inputSha256: { before: before.inputSha256, after: after.inputSha256 },
    method: change(before.method, after.method), files: diffRows([...before.inventory, ...before.inputs], [...after.inventory, ...after.inputs], item => item.file),
    coverage: change(before.coverage, after.coverage), dependencies: { ...dependencies, groups: change(before.dependencies.groups, after.dependencies.groups) },
    duplicates: diffRows(before.duplicates, after.duplicates, item => json([item.sha256, item.spans])),
    contract: { ...diffRows(before.contract.operations, after.contract.operations, item => item.id),
      sha256: change(before.contract.sha256, after.contract.sha256), schemaVersion: change(before.contract.schemaVersion, after.contract.schemaVersion),
      resourcePaths: change(before.contract.resourcePaths, after.contract.resourcePaths) },
    persistence: { ...diffRows(before.persistence.objects, after.persistence.objects, item => `${item.type}:${item.name}`),
      sha256: change(before.persistence.sha256, after.persistence.sha256), userVersion: change(before.persistence.userVersion, after.persistence.userVersion),
      applicationId: change(before.persistence.applicationId, after.persistence.applicationId),
      migrationSources: diffRows(before.persistence.migrationSources, after.persistence.migrationSources, item => item.file) },
    build,
  };
}

try {
  const args = process.argv.slice(2);
  const skipFlags = args.filter(arg => arg === '--skip-build').length;
  const [mode, reference, ...extra] = args.filter(arg => arg !== '--skip-build');
  const comparing = mode === '--check' || mode === '--compare';
  if (skipFlags > 1 || extra.length || (mode && !['--help', '--write'].includes(mode) && !comparing) ||
      ((reference || skipFlags) && !comparing) || reference?.startsWith('--')) {
    throw new Error('Usage: node scripts/architecture-baseline.mjs [--write | --check [path] [--skip-build] | --compare [path] [--skip-build]]');
  }
  if (mode === '--help') console.log('Print or --write the current snapshot. Use --compare/--check against an optional reference JSON and --skip-build for a static-only comparison.');
  else {
    const before = comparing ? JSON.parse(readFileSync(reference ? resolve(reference) : savedPath, 'utf8')) : undefined;
    if (before && !skipFlags && before.build?.source?.worktree !== worktree) {
      throw new Error('Build comparison requires a reference produced by npm run build in this worktree. Use --skip-build for a static-only comparison.');
    }
    const after = await snapshot(!skipFlags);
    const result = before ? compare(before, after) : after;
    const output = JSON.stringify(result, null, 2) + '\n';
    if (mode === '--write') writeFileSync(savedPath, output);
    else process.stdout.write(output);
    if (mode === '--check' && result.stale) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
