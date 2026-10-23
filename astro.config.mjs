import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://www.accudyne.com',
  trailingSlash: 'always',
  integrations: [sitemap()],
  // Short URLs the old WordPress site redirected.
  redirects: {
    '/careers/': '/about/careers/',
    '/contact/': '/contact-us/',
  },
});
