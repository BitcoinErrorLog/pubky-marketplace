#!/usr/bin/env node
// Print each *.vrt.test.tsx whose import closure contains a changed file.
// Usage: node scripts/vrt-related.mjs <repo-relative-path>...
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const changed = new Set(
  process.argv.slice(2).map((file) => file.replaceAll('\\', '/')),
);

const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
const aliasEntries = Object.entries(tsconfig.compilerOptions.paths).sort(
  (left, right) => right[0].length - left[0].length,
);

function aliasBase(specifier) {
  for (const [key, targets] of aliasEntries) {
    const target = String(targets[0]).replace(/^\.\//, '');
    if (key.endsWith('/*')) {
      const prefix = key.slice(0, -1);
      if (specifier.startsWith(prefix)) {
        return join(root, target.replace('*', specifier.slice(prefix.length)));
      }
    } else if (specifier === key) {
      return join(root, target);
    }
  }
  return null;
}

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('._')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else if (entry.name.endsWith('.vrt.test.tsx') || entry.name.endsWith('.vrt.test.ts')) {
      acc.push(path);
    }
  }
  return acc;
}

const importCache = new Map();
const importPattern =
  /(?:import|export)\b[^'"\n]*?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const cssImportPattern = /@import\s+(?:url\()?['"]([^'"]+)['"]|url\(\s*['"]?([^'")]+)['"]?\s*\)/g;

function resolveSpecifier(fromFile, specifier) {
  let base;
  if (specifier.startsWith('@/')) base = aliasBase(specifier);
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null;
  if (!base) return null;

  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    `${base}.css`,
    join(base, 'index.tsx'),
    join(base, 'index.ts'),
    join(base, 'index.jsx'),
    join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // missing candidate
    }
  }
  return null;
}

function importsOf(file) {
  const cached = importCache.get(file);
  if (cached) return cached;
  const found = [];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    importCache.set(file, found);
    return found;
  }
  const pattern = file.endsWith('.css') ? cssImportPattern : importPattern;
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text))) {
    const specifier = match[1] || match[2];
    if (!specifier) continue;
    const resolved = resolveSpecifier(file, specifier);
    if (resolved) found.push(resolved);
  }
  importCache.set(file, found);
  return found;
}

function toRel(file) {
  return relative(root, file).replaceAll('\\', '/');
}

function reachesChanged(start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (changed.has(toRel(file))) return true;
    for (const next of importsOf(file)) stack.push(next);
  }
  return false;
}

const specs = walk(join(root, 'src'), []);
const hits = [];
for (const spec of specs) {
  if (reachesChanged(spec)) hits.push(toRel(spec));
}
hits.sort();
if (hits.length > 0) process.stdout.write(`${hits.join('\n')}\n`);
