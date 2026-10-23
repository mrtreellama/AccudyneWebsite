# Accudyne website (static rebuild)

A static copy of www.accudyne.com built with [Astro](https://astro.build). It has no WordPress, PHP or database: the build output in `dist/` is plain HTML, CSS, JS and images that any web host can serve.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies (first time only) |
| `npm run dev` | Live-reloading local server at http://localhost:4321 (search is off in this mode) |
| `npm run build` | Build the site into `dist/` and generate the search index |
| `npm run preview` | Serve the built `dist/` at http://localhost:4321 |
| `npm run check-links` | After a build, confirm every old URL exists and no internal links or images are broken |
| `npm run import` | Re-import content from the live WordPress site (overwrites `src/content/` and `src/data/`) |

## Where things live

- `src/content/pages/*.json`, `src/content/posts/*.json`: one file per page or post (title, URL path, description, body HTML). Edit these to change content.
- `src/data/nav.json`: main menu, top links, logo and footer badges. `src/data/home.json`: home page tiles and "Our Approach".
- `src/components/`, `src/layouts/`, `src/pages/`: templates. `src/styles/site.css`: all styling.
- `public/uploads/`: images, PDFs and video downloaded from the old site, at the same paths under `/uploads/`.
- `scripts/import-wp.mjs`: the one-time importer. `scripts/import-report.md` lists pages worth checking by hand.

## Settings (environment variables at build time)

- `PUBLIC_FORM_ENDPOINT`: where the contact form posts. Use a Formspree form URL, or `/contact.php` on PHP hosting such as BlueHost (`public/contact.php` emails info@accudyne.com). If it's unset, the form tells visitors to email instead.
- `PUBLIC_NOINDEX=true`: adds `noindex` to every page, for a preview copy that search engines should ignore.

Example: `PUBLIC_FORM_ENDPOINT=/contact.php PUBLIC_NOINDEX=true npm run build`

## Deploying

Upload the contents of `dist/` to the web root (for example `public_html/` or a subdomain folder on BlueHost). URLs match the old site, including trailing slashes.
