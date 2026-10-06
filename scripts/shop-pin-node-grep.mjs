// Shop pin gate: the `@bitcoinerrorlog/pubky-shop` `.` export that Next transpiles
// into the client bundle must not evaluate Node builtins. A naive `node:`
// substring match is not the gate — minified client JS contains `{node:` keys.
// This script counts quoted builtin specifiers and walks the browser entry.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_NAME = '@bitcoinerrorlog/pubky-shop';
const PACKAGE_DIR = join(ROOT, 'node_modules', PACKAGE_NAME);

const MODULE_SPECIFIER = /\b(?:from|import)\s*(?:\(\s*)?['"]([^'"]+)['"]/g;
const QUOTED_NODE_BUILTIN = /['"]node:[a-zA-Z][a-zA-Z0-9_./-]*['"]/g;

export function moduleSpecifiers(source) {
  return [...source.matchAll(MODULE_SPECIFIER)].map((match) => match[1]).filter(Boolean);
}

export function quotedNodeBuiltins(source) {
  return [...source.matchAll(QUOTED_NODE_BUILTIN)].map((match) => match[0].slice(1, -1));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resolveRelative(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const target = resolve(dirname(fromFile), specifier);
  if (existsSync(target) && statSync(target).isFile()) return target;
  if (existsSync(`${target}.js`)) return `${target}.js`;
  return null;
}

export function walkBrowserEntry(packageDir) {
  const pkg = readJson(join(packageDir, 'package.json'));
  const entryRel = pkg.exports?.['.']?.import;
  if (typeof entryRel !== 'string' || !entryRel.startsWith('./')) {
    throw new Error(`${PACKAGE_NAME} exports["."].import must be a relative path`);
  }
  const entry = resolve(packageDir, entryRel);
  const nodeSpecifiers = [];
  const externalSpecifiers = [];
  const missing = [];
  const files = [];
  const pending = [entry];
  const seen = new Set();

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const inside = file === packageDir || file.startsWith(`${packageDir}${sep}`);
    if (!inside) {
      missing.push(relative(packageDir, file));
      continue;
    }
    files.push(relative(packageDir, file));
    const source = readFileSync(file, 'utf8');
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.startsWith('node:')) {
        nodeSpecifiers.push({ file: relative(packageDir, file), specifier });
        continue;
      }
      if (!specifier.startsWith('.')) {
        externalSpecifiers.push({ file: relative(packageDir, file), specifier });
        continue;
      }
      const next = resolveRelative(file, specifier);
      if (!next) {
        missing.push(`${relative(packageDir, file)} -> ${specifier}`);
        continue;
      }
      pending.push(next);
    }
  }

  files.sort();
  return { version: pkg.version, files, nodeSpecifiers, externalSpecifiers, missing };
}

function walkJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('._')) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      files.push(...walkJsFiles(path));
      continue;
    }
    if (entry.endsWith('.js')) files.push(path);
  }
  return files;
}

export function scanStaticDir(staticDir) {
  const hits = [];
  const files = walkJsFiles(staticDir);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of quotedNodeBuiltins(source)) {
      hits.push({ file: relative(staticDir, file), specifier });
    }
  }
  return { files: files.length, hits };
}

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('._')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry) && !/\.(test|live)(\.|$)/.test(entry)) files.push(path);
  }
  return files;
}

export function shopNodeExportImports(srcDir) {
  const needle = `${PACKAGE_NAME}/node`;
  const hits = [];
  for (const file of sourceFiles(srcDir)) {
    const source = readFileSync(file, 'utf8');
    if (source.includes(needle)) hits.push(relative(ROOT, file));
  }
  return hits;
}

function assertEqual(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${label}\n actual: ${left}\n expected: ${right}`);
  }
}

export function selfTest() {
  assertEqual(moduleSpecifiers('import { readFile } from "node:fs";'), ['node:fs'], 'from double');
  assertEqual(moduleSpecifiers("export { x } from 'node:path';"), ['node:path'], 'export from');
  assertEqual(moduleSpecifiers('await import("node:crypto")'), ['node:crypto'], 'dynamic');
  assertEqual(moduleSpecifiers('import "node:fs/promises";'), ['node:fs/promises'], 'bare');
  assertEqual(quotedNodeBuiltins('const o = {node: rect};'), [], 'object key');
  assertEqual(quotedNodeBuiltins('env:{browser:!0,node:!0,es6:!0}'), [], 'minified key');
  assertEqual(quotedNodeBuiltins('import("node:fs")'), ['node:fs'], 'quoted builtin');

  const dir = mkdtempSync(join(tmpdir(), 'shop-pin-node-grep-'));
  try {
    const bad = join(dir, 'bad');
    mkdirSync(bad);
    writeFileSync(
      join(bad, 'package.json'),
      JSON.stringify({ name: 'bad', version: '0.0.0', exports: { '.': { import: './index.js' } } }),
    );
    writeFileSync(join(bad, 'index.js'), 'export { read } from "./uses-node.js";\n');
    writeFileSync(join(bad, 'uses-node.js'), 'import { readFile } from "node:fs";\nexport const read = readFile;\n');
    const badWalk = walkBrowserEntry(bad);
    assertEqual(
      badWalk.nodeSpecifiers.map((hit) => hit.specifier),
      ['node:fs'],
      'graph reaches node:fs',
    );

    const good = join(dir, 'good');
    mkdirSync(good);
    writeFileSync(
      join(good, 'package.json'),
      JSON.stringify({ name: 'good', version: '0.0.0', exports: { '.': { import: './index.js' } } }),
    );
    writeFileSync(join(good, 'index.js'), 'export { ok } from "./ok.js";\n');
    writeFileSync(join(good, 'ok.js'), 'export const ok = 1;\n');
    writeFileSync(join(good, 'node.js'), 'import { readFile } from "node:fs";\n');
    const goodWalk = walkBrowserEntry(good);
    assertEqual(goodWalk.nodeSpecifiers, [], 'node entry stays off the browser graph');
    assertEqual(goodWalk.externalSpecifiers, [], 'browser graph stays relative');

    const staticDir = join(dir, 'static');
    mkdirSync(join(staticDir, 'chunks'), { recursive: true });
    writeFileSync(join(staticDir, 'chunks', 'ok.js'), 'const o = {node: 1}; env:{node:!0};');
    writeFileSync(join(staticDir, 'chunks', 'bad.js'), 'import("node:fs");');
    const scanned = scanStaticDir(staticDir);
    assertEqual(
      scanned.hits.map((hit) => hit.specifier),
      ['node:fs'],
      'static scan ignores object keys',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function pinVersions() {
  const pkg = readJson(join(ROOT, 'package.json'));
  const lock = readJson(join(ROOT, 'package-lock.json'));
  const declared = pkg.dependencies?.[PACKAGE_NAME];
  const locked = lock.packages?.[`node_modules/${PACKAGE_NAME}`]?.version;
  if (!declared || /[\^~*]|\bx\b/.test(declared)) {
    throw new Error(`${PACKAGE_NAME} must be an exact dependency, got ${declared}`);
  }
  if (declared !== locked) {
    throw new Error(`${PACKAGE_NAME} package.json ${declared} does not match the lockfile ${locked}`);
  }
  return declared;
}

function report(requireStatic) {
  selfTest();
  console.log('self_test=pass');

  const declared = pinVersions();
  if (!existsSync(join(PACKAGE_DIR, 'package.json'))) {
    throw new Error(`missing ${PACKAGE_DIR}; install dependencies before the pin grep`);
  }
  const walked = walkBrowserEntry(PACKAGE_DIR);
  if (walked.version !== declared) {
    throw new Error(`installed ${PACKAGE_NAME}@${walked.version} does not match pin ${declared}`);
  }
  const shopHits = shopNodeExportImports(join(ROOT, 'src'));
  console.log(`pin=${declared}`);
  console.log(`browser_files=${walked.files.length}`);
  console.log(`browser_node_specifiers=${walked.nodeSpecifiers.length}`);
  console.log(`browser_external_specifiers=${walked.externalSpecifiers.length}`);
  console.log(`browser_missing=${walked.missing.length}`);
  console.log(`shop_node_export_imports=${shopHits.length}`);
  if (walked.nodeSpecifiers.length || walked.externalSpecifiers.length || walked.missing.length || shopHits.length) {
    console.log(JSON.stringify({ walked, shopHits }, null, 2));
    throw new Error('Shop pin browser entry is not free of Node builtins');
  }

  const staticDir = join(ROOT, '.next', 'static');
  if (!existsSync(staticDir)) {
    console.log('static_dir=missing');
    if (requireStatic) throw new Error('--require-static needs .next/static from `npm run build`');
    return;
  }
  const scanned = scanStaticDir(staticDir);
  console.log(`static_js_files=${scanned.files}`);
  console.log(`static_quoted_node_specifiers=${scanned.hits.length}`);
  if (scanned.hits.length) {
    console.log(JSON.stringify(scanned.hits.slice(0, 40), null, 2));
    throw new Error('client bundle quotes a node: builtin specifier');
  }
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirect) {
  try {
    report(process.argv.includes('--require-static'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
