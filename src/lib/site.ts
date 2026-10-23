import { getCollection, type CollectionEntry } from 'astro:content';

export type Entry = CollectionEntry<'pages'> | CollectionEntry<'posts'>;

export const SITE = {
  name: 'Accudyne Systems, Inc.',
  phone: '(302) 369-5390',
  phoneHref: 'tel:13023695390',
  email: 'info@accudyne.com',
};

export async function allPages() {
  return (await getCollection('pages')).map(e => e.data);
}

export async function allPosts() {
  return (await getCollection('posts')).map(e => e.data).sort((a, b) => b.date.localeCompare(a.date));
}

/** Breadcrumb trail for a page path, using page titles where they exist. */
export async function breadcrumbs(path: string, title: string) {
  const byPath = new Map((await allPages()).map(p => [p.path, p.title]));
  const crumbs = [{ title: 'Home', href: '/' }];
  if (/^\/\d{4}\//.test(path)) {
    crumbs.push({ title: 'News', href: '/news/' });
  } else {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const p = '/' + parts.slice(0, i).join('/') + '/';
      if (byPath.has(p)) crumbs.push({ title: byPath.get(p)!, href: p });
    }
  }
  crumbs.push({ title, href: path });
  return crumbs;
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Split imported HTML around the contact-form placeholder. */
export function splitForm(html: string): [string, string] | null {
  const marker = '<div data-contact-form=""></div>';
  const i = html.indexOf(marker);
  return i === -1 ? null : [html.slice(0, i), html.slice(i + marker.length)];
}
