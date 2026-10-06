#!/usr/bin/env node
// Builds a single browsable page of every committed VRT baseline, grouped by
// suite and scenario. Useful for reviewing baselines by eye, which VRT itself
// does not do — it only proves they stopped changing.
//
// Usage: node scripts/vrt-gallery.mjs [outputPath]
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const VRT_ROOT = resolve('src/test/vrt');
const OUT = resolve(process.argv[2] ?? '.vrt-gallery.html');

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.png') ? [full] : [];
  });
}

const shots = walk(VRT_ROOT).sort();
if (shots.length === 0) {
  console.error('No baselines found under src/test/vrt.');
  process.exit(1);
}

const suites = new Map();
for (const file of shots) {
  const rel = relative(VRT_ROOT, file);
  const suite = rel.match(/([^/]+\.vrt\.test\.tsx)/)?.[1] ?? 'other';
  const base = rel.split('/').pop().replace(/\.png$/, '');
  const platform = base.match(/-(chromium|firefox|webkit)-(linux|darwin)$/)?.[0]?.slice(1) ?? 'unknown';
  const scenario = base.replace(/-(chromium|firefox|webkit)-(linux|darwin)$/, '');
  if (!suites.has(suite)) suites.set(suite, new Map());
  const scenarios = suites.get(suite);
  if (!scenarios.has(scenario)) scenarios.set(scenario, []);
  scenarios.get(scenario).push({ platform, src: file });
}

const esc = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const body = [...suites]
  .map(([suite, scenarios]) => {
    const sections = [...scenarios]
      .map(([scenario, images]) => {
        const cells = images
          .sort((a, b) => a.platform.localeCompare(b.platform))
          .map(
            ({ platform, src }) =>
              `<figure><a href="file://${src}" target="_blank"><img loading="lazy" src="file://${src}" alt="${esc(scenario)} ${esc(platform)}"></a><figcaption>${esc(platform)}</figcaption></figure>`,
          )
          .join('');
        return `<section><h3>${esc(scenario)}</h3><div class="row">${cells}</div></section>`;
      })
      .join('');
    return `<article><h2>${esc(suite)} <span class="count">${scenarios.size} scenarios</span></h2>${sections}</article>`;
  })
  .join('');

writeFileSync(
  OUT,
  `<!doctype html><meta charset="utf-8"><title>Marketplace VRT baselines</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:32px;background:#0b0b0c;color:#e7e7e9;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
h1{font-size:22px;margin:0 0 4px}
.meta{color:#8b8b93;margin-bottom:32px}
article{margin-bottom:48px}
h2{font-size:17px;border-bottom:1px solid #26262b;padding-bottom:8px}
.count{color:#8b8b93;font-weight:400;font-size:13px}
h3{font-size:14px;color:#c9c9d1;margin:24px 0 8px;font-family:ui-monospace,monospace}
.row{display:flex;gap:16px;flex-wrap:wrap}
figure{margin:0}
img{max-width:420px;border:1px solid #26262b;border-radius:8px;display:block;background:#000}
figcaption{color:#8b8b93;font-size:12px;margin-top:6px;font-family:ui-monospace,monospace}
</style>
<h1>Marketplace VRT baselines</h1>
<div class="meta">${shots.length} images across ${suites.size} suite(s). Click any image to open it full size.</div>
${body}`,
);

console.log(`Wrote ${OUT} (${shots.length} images, ${suites.size} suites)`);
