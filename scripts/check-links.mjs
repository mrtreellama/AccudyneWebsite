// Checks the built site in dist/:
//  - every page and post URL from the WordPress import exists
//  - every internal link, image, video and stylesheet reference resolves to a file
//
//   npm run build && npm run check-links

import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const DIST = path.resolve('dist');

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function exists(urlPath) {
  const clean = decodeURIComponent(urlPath.split(/[?#]/)[0]);
  const target = path.join(DIST, clean);
  try {
    const st = await fs.stat(target);
    if (st.isDirectory()) { await fs.access(path.join(target, 'index.html')); }
    return true;
  } catch {
    return false;
  }
}

const problems = [];

// 1. Expected URLs from the import.
const expected = [];
for (const dir of ['src/content/pages', 'src/content/posts']) {
  for (const f of await fs.readdir(dir)) expected.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')).path);
}
for (const p of expected) if (!(await exists(p))) problems.push(`missing page: ${p}`);

// 2. References inside built HTML.
const htmlFiles = (await walk(DIST)).filter(f => f.endsWith('.html'));
const seen = new Map();
for (const file of htmlFiles) {
  const from = '/' + path.relative(DIST, file).replace(/\\/g, '/').replace(/index\.html$/, '');
  const $ = cheerio.load(await fs.readFile(file, 'utf8'));
  $('a[href], img[src], video[src], source[src], link[href], script[src]').each((i, el) => {
    const ref = $(el).attr('href') ?? $(el).attr('src');
    if (!ref || !ref.startsWith('/') || ref.startsWith('//')) return;
    if (!seen.has(ref)) seen.set(ref, new Set());
    seen.get(ref).add(from);
  });
}
for (const [ref, froms] of seen) {
  if (!(await exists(ref))) problems.push(`broken: ${ref}  (on ${[...froms].slice(0, 3).join(', ')}${froms.size > 3 ? ` +${froms.size - 3} more` : ''})`);
}

console.log(`Checked ${expected.length} imported URLs and ${seen.size} internal references across ${htmlFiles.length} HTML files.`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  ' + p);
  process.exitCode = 1;
} else {
  console.log('No problems found.');
}
