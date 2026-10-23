// One-time (re-runnable) import of www.accudyne.com into static content files.
//
// Page/post metadata comes from the WordPress REST API; body content is taken
// from the live rendered pages (so WPBakery/theme shortcodes are already
// expanded) and cleaned down to plain semantic HTML plus a few layout classes
// that src/styles/site.css understands. Images and documents referenced from
// /wp-content/uploads/ are downloaded into public/uploads/.
//
//   node scripts/import-wp.mjs            (uses scripts/.cache, delete it to refetch)

import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { ORIGIN, get, getJson, restAll, pool } from './wp-fetch.mjs';

const PAGES_DIR = 'src/content/pages';
const POSTS_DIR = 'src/content/posts';
const DATA_DIR = 'src/data';
const PUBLIC = 'public';
const SLIDES_DIR = 'src/assets/slides';

const report = { thin: [], downloads: 0, failedDownloads: [], notes: [] };
const assets = new Map(); // remote url -> local public path

// ---------- URL helpers ----------

const HOSTS = /^(https?:)?\/\/(www\.)?accudyne\.com/i;

/** Absolute site URL -> root-relative path ("/about/"), or null if external. */
function sitePath(href) {
  if (!href) return null;
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  if (HOSTS.test(href)) return href.replace(HOSTS, '') || '/';
  return null;
}

/** Register an uploads URL for download and return its local path. */
function asset(url) {
  const p = sitePath(url);
  if (!p || !p.startsWith('/wp-content/uploads/')) return null;
  const clean = p.split(/[?#]/)[0];
  const local = '/uploads/' + clean.slice('/wp-content/uploads/'.length);
  assets.set(ORIGIN + clean, local);
  return local;
}

function externalAsset(url, name) {
  const local = '/uploads/external/' + name;
  assets.set(url, local);
  return local;
}

function rewriteHref(href) {
  if (!href) return href;
  if (href.startsWith('/cdn-cgi/l/email-protection#')) return 'mailto:' + cfDecode(href.split('#')[1]);
  const up = asset(href);
  if (up) return up;
  const p = sitePath(href);
  if (p === null) return href;
  // Normalise internal page links to trailing-slash form like WordPress serves.
  const [pathname, rest = ''] = p.split(/(?=[?#])/);
  if (pathname && !path.extname(pathname) && !pathname.endsWith('/')) return pathname + '/' + rest;
  return p;
}

function cfDecode(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let s = '';
  for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return s;
}

function bgUrl(style = '') {
  const m = style.match(/background(?:-image)?:[^;]*url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
  return m ? m[1] : null;
}

// ---------- content cleaning ----------

const KEEP_ATTRS = {
  a: ['href', 'title', 'class'],
  img: ['src', 'alt', 'width', 'height', 'class'],
  iframe: ['src', 'width', 'height', 'allowfullscreen', 'title', 'loading'],
  video: ['controls', 'src', 'poster', 'preload'],
  source: ['src', 'type'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  ol: ['start'],
  '*': ['class', 'style', 'open', 'id'],
};

// Classes we produce on purpose; everything else from WordPress is dropped.
const OUR_CLASSES = new Set([
  'row', 'col', 'center', 'align-left', 'align-right', 'align-center', 'gallery', 'side-nav', 'widget-title',
  'btn', 'card', 'cards', 'team', 'team-member', 'position', 'stats', 'stat', 'has-bg', 'figure', 'round',
  'current', 'map', 'video', 'files', 'section', 'lede', 'post-meta',
]);

function spanFromVc(cls) {
  const m = cls.match(/vc_col-(?:xs|sm|md|lg)-(\d+)/);
  return m ? Number(m[1]) : 12;
}
function spanFromFraction(cls) {
  const m = cls.match(/column-(\d+)_(\d+)/);
  return m ? Math.round((12 * Number(m[1])) / Number(m[2])) : 12;
}

function clean($, root, ctx) {
  root.find('script, style, noscript, meta, link, svg title').remove();
  root.contents().filter((i, n) => n.type === 'comment').remove();
  root.find('*').contents().filter((i, n) => n.type === 'comment').remove();

  // Things that only make sense inside WordPress.
  root.find('.post_counters, .post_info_counters, .post_counters_item, .vc_row-full-width, .sc_section_overlay:empty').remove();
  root.find('[itemprop=publisher], [itemprop=author], span[itemprop=image]').remove();

  // Email obfuscation from Cloudflare.
  root.find('.__cf_email__').each((i, el) => {
    $(el).replaceWith(cfDecode($(el).attr('data-cfemail') || ''));
  });
  root.find('a[href^="/cdn-cgi/l/email-protection"]').each((i, el) => {
    const hex = $(el).attr('href').split('#')[1];
    if (hex) $(el).attr('href', 'mailto:' + cfDecode(hex));
  });

  // Forms -> marker the page template swaps for the ContactForm component.
  root.find('.sc_popup').remove();
  root.find('.sc_form_wrap, form').each((i, el) => {
    $(el).replaceWith('<div data-contact-form></div>');
    ctx.hasForm = true;
  });
  root.find('a[href="#popup_form"], a[href^="#sc_popup"]').attr('href', '/contact-us/#contact-form');

  // Google map shortcode -> plain embed.
  root.find('.sc_googlemap').each((i, el) => {
    const addr = encodeURIComponent($(el).find('.sc_googlemap_marker').attr('data-address') || '210 Executive Drive, Suite 5, Newark, DE 19702');
    $(el).replaceWith(`<div class="map"><iframe src="https://maps.google.com/maps?q=${addr}&output=embed" title="Map" loading="lazy" width="100%" height="450"></iframe></div>`);
  });

  // Accordions -> <details>.
  root.find('.sc_accordion_item').each((i, el) => {
    const title = $(el).find('.sc_accordion_title').first().text().trim();
    const body = $(el).find('.sc_accordion_content').first().html() || '';
    $(el).replaceWith(`<details><summary>${title}</summary>${body}</details>`);
  });

  // Image galleries (WPBakery) -> simple grid of thumbnail links to full size.
  root.find('.wpb_gallery').each((i, el) => {
    const heading = $(el).find('.wpb_gallery_heading').text().trim();
    const items = $(el).find('li, .isotope-item').map((j, li) => {
      const a = $(li).find('a').first();
      const img = $(li).find('img').first();
      if (!img.length) return '';
      const full = a.attr('href') || img.attr('src');
      return `<a href="${full}"><img src="${img.attr('src')}" alt="${(img.attr('alt') || '').replace(/"/g, '&quot;')}" width="${img.attr('width') || ''}" height="${img.attr('height') || ''}"></a>`;
    }).get().join('');
    $(el).replaceWith((heading ? `<h3>${heading}</h3>` : '') + `<div class="gallery">${items}</div>`);
  });

  // Sidebar menus inside content -> side-nav.
  root.find('.widget_nav_menu').each((i, el) => {
    const title = $(el).find('.widget_title').first().text().trim();
    const links = $(el).find('li > a').map((j, a) => {
      const cur = $(a).parent().is('.current-menu-item, .current_page_item') ? ' class="current"' : '';
      return `<li${cur}><a href="${$(a).attr('href')}">${$(a).text().trim()}</a></li>`;
    }).get().join('');
    $(el).replaceWith(`<nav class="side-nav">${title ? `<h3 class="widget-title">${title}</h3>` : ''}<ul>${links}</ul></nav>`);
  });

  // Team members.
  root.find('.sc_team_item').each((i, el) => {
    const img = $(el).find('.sc_team_item_avatar img').first();
    const name = $(el).find('.sc_team_item_title').text().trim();
    const pos = $(el).find('.sc_team_item_position').text().trim();
    const desc = $(el).find('.sc_team_item_description').html() || '';
    $(el).replaceWith(`<div class="team-member">${img.length ? `<img src="${img.attr('src')}" alt="${name}" class="round">` : ''}<h3>${name}</h3>${pos ? `<p class="position">${pos}</p>` : ''}${desc}</div>`);
  });
  root.find('.sc_team').addClass('team');

  // Services items -> cards.
  root.find('.sc_services_item').each((i, el) => {
    const img = $(el).find('img').first();
    const a = $(el).find('a').first();
    const title = $(el).find('.sc_services_item_title').text().trim();
    const desc = $(el).find('.sc_services_item_description').html() || '';
    const href = a.attr('href');
    const t = href ? `<a href="${href}">${title}</a>` : title;
    $(el).replaceWith(`<div class="card">${img.length ? `<img src="${img.attr('src')}" alt="${title}">` : ''}<h3>${t}</h3>${desc}</div>`);
  });

  // Skills counters -> stats.
  root.find('.sc_skills_item').each((i, el) => {
    const num = $(el).find('[data-stop]').attr('data-stop') || $(el).find('.sc_skills_total').text().trim();
    const ed = $(el).find('[data-ed]').attr('data-ed') || '';
    const label = $(el).find('.sc_skills_label').text().trim() || $(el).closest('.sc_skills_column').find('.sc_skills_info').text().trim();
    $(el).replaceWith(`<div class="stat"><strong>${num}${ed}</strong><span>${label}</span></div>`);
  });
  root.find('.sc_skills').addClass('stats');

  // Testimonials.
  root.find('.sc_testimonial_item').each((i, el) => {
    const content = $(el).find('.sc_testimonial_content').html() || '';
    const name = $(el).find('.sc_testimonial_author_name').text().trim();
    const pos = $(el).find('.sc_testimonial_author_position').text().trim();
    $(el).replaceWith(`<blockquote>${content}<cite>${name}${pos ? ', ' + pos : ''}</cite></blockquote>`);
  });

  // Tag archives aren't part of the static site.
  root.find('a[href*="/tag/"]').each((i, el) => { $(el).replaceWith($(el).text()); });

  // Buttons.
  root.find('.sc_button, .wp-block-file__button, .wp-block-button__link').addClass('btn');

  // Layout: rows and columns.
  root.find('.vc_row, .columns_wrap, .wp-block-columns').each((i, el) => $(el).addClass('row'));
  root.find('.vc_column_container').each((i, el) => {
    $(el).addClass(`col col-${spanFromVc($(el).attr('class'))}`);
  });
  root.find('[class*="column-"]').each((i, el) => {
    if (/(^|\s)column-\d+_\d+/.test($(el).attr('class'))) $(el).addClass(`col col-${spanFromFraction($(el).attr('class'))}`);
  });
  root.find('.wp-block-column').addClass('col col-6');

  // Section backgrounds (inline style or VC custom CSS classes).
  root.find('*').each((i, el) => {
    const $el = $(el);
    let bg = bgUrl($el.attr('style'));
    if (!bg) {
      for (const c of ($el.attr('class') || '').split(/\s+/)) if (ctx.vcBg[c]) bg = ctx.vcBg[c];
    }
    if (bg) {
      const local = asset(bg) || bg;
      $el.addClass('has-bg');
      $el.attr('data-bg', local);
    }
  });

  // Alignment.
  root.find('*').each((i, el) => {
    const $el = $(el);
    const cls = $el.attr('class') || '';
    const style = $el.attr('style') || '';
    if (/\b(sc_align_center|aligncenter|vc_align_center|has-text-align-center)\b/.test(cls) || /text-align:\s*center/.test(style)) $el.addClass('center');
    if (/\balignleft\b/.test(cls) && el.tagName !== 'div') $el.addClass('align-left');
    if (/\balignright\b/.test(cls)) $el.addClass('align-right');
    if (/\b(vc_box_circle|sc_image_shape_round)\b/.test(cls)) $el.find('img').addBack('img').addClass('round');
  });

  // Videos.
  root.find('.wp-video').each((i, el) => {
    const src = $(el).find('source').attr('src') || $(el).find('a').attr('href');
    $(el).replaceWith(`<div class="video"><video controls preload="metadata" src="${src.split('?')[0]}"></video></div>`);
  });
  root.find('.wp-block-file').addClass('files');

  // Images: pick the real source, drop responsive variants.
  root.find('img').each((i, el) => {
    const $el = $(el);
    const src = $el.attr('data-src') || $el.attr('data-lazyload') || $el.attr('src');
    $el.attr('src', src);
    if (!$el.attr('alt')) $el.attr('alt', $el.attr('title') || '');
  });

  // Strip WordPress attributes and classes.
  root.find('*').each((i, el) => {
    const tag = el.tagName;
    const keep = new Set([...(KEEP_ATTRS[tag] || []), ...KEEP_ATTRS['*']]);
    const bg = $(el).attr('data-bg');
    for (const name of Object.keys(el.attribs)) if (!keep.has(name)) $(el).removeAttr(name);
    const cls = ($(el).attr('class') || '').split(/\s+/).filter(c => OUR_CLASSES.has(c) || /^col-\d+$/.test(c));
    if (cls.length) $(el).attr('class', [...new Set(cls)].join(' ')); else $(el).removeAttr('class');
    $(el).removeAttr('style');
    if (bg) $(el).attr('style', `--bg:url('${bg}')`);
    if ($(el).attr('id') && !/contact/.test($(el).attr('id'))) $(el).removeAttr('id');
  });

  // Rewrite links and image sources.
  root.find('a[href]').each((i, el) => $(el).attr('href', rewriteHref($(el).attr('href'))));
  root.find('img[src], video[src], source[src], video[poster]').each((i, el) => {
    for (const a of ['src', 'poster']) {
      const v = $(el).attr(a);
      if (!v) continue;
      const local = asset(v);
      if (local) $(el).attr(a, local);
      else if (/^https?:/.test(v) && !HOSTS.test(v)) {
        $(el).attr(a, externalAsset(v, path.basename(new URL(v).pathname)));
      }
    }
    if (el.tagName === 'img') $(el).attr('loading', 'lazy');
  });

  // Unwrap wrapper divs/spans that carry nothing anymore.
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    root.find('div, span').each((i, el) => {
      if (Object.keys(el.attribs).length === 0) {
        $(el).replaceWith($(el).contents());
        changed = true;
      }
    });
    if (!changed) break;
  }
  // A row with a single full-width column is just a section.
  root.find('.row').each((i, el) => {
    const kids = $(el).children();
    if (kids.length === 1 && kids.first().is('.col-12')) {
      kids.first().replaceWith(kids.first().contents());
      $(el).attr('class', ($(el).attr('class') || '').replace(/\brow\b/, 'section').trim());
    }
  });
  root.find('.section').each((i, el) => {
    if (!$(el).attr('style') && ($(el).attr('class') || '').trim() === 'section') $(el).replaceWith($(el).contents());
  });
  root.find('p, h1, h2, h3, h4, h5, h6, figure').each((i, el) => {
    if (!$(el).text().trim() && !$(el).find('img, iframe, video, [data-contact-form]').length) $(el).remove();
  });

  return root.html().replace(/\n\s*\n+/g, '\n').trim();
}

function vcBackgrounds($) {
  const map = {};
  const css = $('style[data-type=vc_shortcodes-custom-css]').html() || '';
  for (const m of css.matchAll(/\.(vc_custom_\d+)\{([^}]*)\}/g)) {
    const u = bgUrl(m[2]);
    if (u) map[m[1]] = u;
  }
  return map;
}

// ---------- navigation (taken from the live header/footer) ----------

function menuTree($, ul) {
  return ul.children('li').map((i, li) => {
    const a = $(li).children('a');
    const href = a.attr('href');
    const sub = $(li).children('ul');
    return {
      title: a.text().trim(),
      href: href && href !== '#' ? rewriteHref(href) : null,
      children: sub.length ? menuTree($, sub) : [],
    };
  }).get();
}

async function importNav() {
  const $ = cheerio.load(await get(ORIGIN + '/about/'));
  const main = menuTree($, $('ul#menu_main').first());
  const top = $('.top_panel_top a').map((i, a) => ({ title: $(a).text().trim(), href: rewriteHref($(a).attr('href')) })).get()
    .filter(l => l.title && !l.href.startsWith('tel:') && !l.href.startsWith('mailto:'));
  const footerLinks = $('.copyright_wrap a').map((i, a) => ({ title: $(a).text().trim(), href: rewriteHref($(a).attr('href')) })).get();
  const logo = asset($('.logo_main').first().attr('src'));
  const badges = $('.footer_wrap img').map((i, img) => {
    const src = $(img).attr('src');
    const a = $(img).closest('a').attr('href');
    return {
      src: asset(src) || externalAsset(src, path.basename(new URL(src).pathname)),
      alt: $(img).attr('alt') || '',
      href: a ? rewriteHref(a) : null,
    };
  }).get();
  const linkedin = $('.footer_wrap a.social_linkedin').attr('href');
  const favicon = asset($('link[rel=icon][sizes="192x192"]').attr('href') || $('link[rel=icon]').attr('href'));
  return { main, top, footerLinks, logo, favicon, badges, linkedin };
}

// ---------- pages & posts ----------

const FIELDS = 'id,slug,link,parent,menu_order,title,date,modified,featured_media,type,excerpt';

async function importItem(item, outDir, mediaById) {
  const html = await get(item.link);
  const $ = cheerio.load(html);
  const urlPath = sitePath(item.link);
  const ctx = { vcBg: vcBackgrounds($), hasForm: false };

  let body = $('[itemprop=articleBody]').first();
  if (!body.length) body = $('.content .post_content').first();
  const bodyHtml = body.length ? clean($, body, ctx) : '';

  const textLen = cheerio.load(bodyHtml || '<p></p>').text().replace(/\s+/g, ' ').trim().length;
  if (textLen < 200 && !/<img/.test(bodyHtml)) report.thin.push(`${urlPath} (${textLen} chars)`);

  const media = mediaById.get(item.featured_media);
  // Posts often have no featured image set; fall back to the first picture in the body.
  const firstImg = cheerio.load(bodyHtml || '<p></p>')('img').first().attr('src') || null;
  const entry = {
    title: cheerio.load(item.title.rendered).text(),
    path: urlPath,
    wpId: item.id,
    parent: item.parent || 0,
    order: item.menu_order || 0,
    date: item.date,
    modified: item.modified,
    description: $('meta[name=description]').attr('content') || '',
    image: (media && asset(media)) || firstImg,
    excerpt: item.excerpt ? cheerio.load(item.excerpt.rendered).text().replace(/\s+/g, ' ').replace(/\s*Read more\s*$/i, '').trim() : '',
    categories: [],
    hasForm: ctx.hasForm,
    html: bodyHtml,
  };
  const file = urlPath === '/' ? 'home' : urlPath.replace(/^\/|\/$/g, '').replace(/\//g, '__');
  await fs.writeFile(path.join(outDir, file + '.json'), JSON.stringify(entry, null, 2));
  return entry;
}

async function downloadAssets() {
  const list = [...assets.entries()];
  await pool(list, 6, async ([url, local]) => {
    const dest = path.join(PUBLIC, decodeURIComponent(local));
    try { await fs.access(dest); return; } catch {}
    try {
      const buf = await get(url, { binary: true });
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buf);
      report.downloads++;
    } catch (e) {
      report.failedDownloads.push(`${url} (${e.message.split(' ')[0]})`);
    }
  });
}

async function main() {
  for (const d of [PAGES_DIR, POSTS_DIR]) {
    await fs.rm(d, { recursive: true, force: true });
    await fs.mkdir(d, { recursive: true });
  }
  await fs.mkdir(DATA_DIR, { recursive: true });

  const [pages, posts] = await Promise.all([restAll('pages', FIELDS), restAll('posts', FIELDS)]);
  const media = await restAll('media', 'id,source_url');
  const mediaById = new Map(media.map(m => [m.id, m.source_url]));
  console.log(`pages ${pages.length}, posts ${posts.length}, media ${media.length}`);

  await pool(pages, 4, p => importItem(p, PAGES_DIR, mediaById));
  await pool(posts, 4, p => importItem(p, POSTS_DIR, mediaById));

  const nav = await importNav();
  await fs.writeFile(path.join(DATA_DIR, 'nav.json'), JSON.stringify(nav, null, 2));

  // Home page pieces that live outside the article body (hero tiles).
  const $ = cheerio.load(await get(ORIGIN + '/'));
  const tiles = $('.slider-wrap .sc_section_inner > .sc_section').map((i, el) => ({
    title: $(el).find('.sc_title').first().text().trim(),
    href: rewriteHref($(el).find('a').first().attr('href')),
    icon: asset($(el).find('img').first().attr('src')),
    background: asset(bgUrl($(el).attr('style'))),
    text: $(el).find('.sc_title').first().nextAll().text().replace(/\s+/g, ' ').trim(),
  })).get();
  const intro = $('.intro-text p').map((i, p) => $(p).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
  const approachTitle = $('.sc_section_title').filter((i, h) => /approach/i.test($(h).text())).first().text().trim();
  const approach = $('.sc_column_item').map((i, el) => ({
    title: $(el).find('h2, h3').first().text().trim(),
    image: asset($(el).find('img').first().attr('src')),
    text: $(el).find('h2, h3').first().nextAll().text().replace(/\s+/g, ' ').trim(),
  })).get();
  const lineBg = Object.values(vcBackgrounds($)).map(asset).filter(Boolean);

  // Revolution Slider slides. Their images go to src/assets/slides/ (not public/)
  // so Astro can resize and convert them at build time.
  await fs.mkdir(SLIDES_DIR, { recursive: true });
  const slides = [];
  for (const el of $('rs-module rs-slide').toArray()) {
    const img = $(el).find('img.rev-slidebg').first();
    const src = new URL(img.attr('data-lazyload') || img.attr('src'), ORIGIN).href;
    const file = path.basename(new URL(src).pathname);
    await fs.writeFile(path.join(SLIDES_DIR, file), await get(src, { binary: true }));
    slides.push({
      image: file,
      alt: img.attr('alt') || '',
      href: rewriteHref($(el).attr('data-link')) || null,
      newTab: $(el).attr('data-target') === '_blank',
    });
  }

  await fs.writeFile(path.join(DATA_DIR, 'home.json'), JSON.stringify({
    slides, tiles, intro, approachTitle, approach, ctaBackground: lineBg[0] || null,
  }, null, 2));

  await downloadAssets();

  const lines = [
    `# Import report (${new Date().toISOString()})`,
    `Assets downloaded this run: ${report.downloads} (total referenced: ${assets.size})`,
    '', '## Pages with little or no content (check by hand)', ...report.thin.map(s => '- ' + s),
    '', '## Failed downloads', ...report.failedDownloads.map(s => '- ' + s),
  ];
  await fs.writeFile('scripts/import-report.md', lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
