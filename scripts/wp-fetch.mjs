// Shared helpers for talking to the live WordPress site, with an on-disk cache
// so the importer can be re-run without re-downloading everything.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const ORIGIN = 'https://www.accudyne.com';
const CACHE = path.resolve('scripts/.cache');
const UA = 'Mozilla/5.0 (accudyne-static-import)';

async function cached(key, fetcher) {
  const file = path.join(CACHE, crypto.createHash('sha1').update(key).digest('hex'));
  try { return await fs.readFile(file); } catch {}
  const data = await fetcher();
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, data);
  return data;
}

export async function get(url, { binary = false } = {}) {
  const buf = await cached(url, async () => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status === 404 || attempt >= 3) throw new Error(`${res.status} ${url}`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  });
  return binary ? buf : buf.toString('utf8');
}

export async function getJson(url) {
  return JSON.parse(await get(url));
}

/** Fetch every item of a REST collection (pages, posts, media...). */
export async function restAll(type, fields) {
  const out = [];
  for (let page = 1; ; page++) {
    let batch;
    try {
      batch = await getJson(`${ORIGIN}/wp-json/wp/v2/${type}?per_page=100&page=${page}&_fields=${fields}`);
    } catch (e) {
      if (page > 1) break; // WordPress returns 400 past the last page
      throw e;
    }
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** Run fn over items with limited concurrency. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}
