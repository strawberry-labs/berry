# berry.me site

The marketing, security, mobile, support and legal pages for berry.me, built
as static HTML, one stylesheet and one small first-party script for motion
(`src/site.js`, which respects reduced motion). No client framework. The one
third-party script is the Google tag for Google Analytics 4 (measurement ID
in `site.config.mjs`, tag in `src/layout.html`); the Content-Security-Policy
written by `scripts/build-site.mjs` allows only the Google hosts it needs, so
change both together, and keep the privacy page's "This website" section
accurate. Plus Jakarta Sans and Geist Mono are self-hosted from
`src/assets/fonts/` (SIL Open Font License, see `LICENSE.txt` there).

```sh
corepack pnpm --filter @berry/site build     # writes apps/site/dist
corepack pnpm --filter @berry/site check     # lists placeholders still to fill
corepack pnpm --filter @berry/site preview   # build, then serve on http://127.0.0.1:4321
```

- `site.config.mjs` holds the company name, address, jurisdiction, contact
  addresses, legal "last updated" dates, store links and whether the
  open-source release is public. Pages read it through `{{name}}` values, so
  each fact is changed in one place.
- `src/layout.html` is the shared header and footer; `src/pages/*.html` are
  the page bodies. Pixel-art icons are PNGs made with Codex image generation
  (`src/assets/icons/`, 128 px, transparent); the illustrations (the data
  hall, the globe) are drawn by `src/art.mjs` at build time. Pages use
  `{{px:name}}` and `{{art:name}}`.
  The dot-matrix berry and footer wordmark are drawn on canvas by
  `src/site.js`; the hero's light streak is BerryCrawl's `hero-glow.avif`. `src/assets/` holds product screenshots, the logo and
  fonts. Red is the only accent colour and text is always a solid colour.

## Share images and icons

`node apps/site/scripts/og-images.mjs` renders the 1200 × 630 share images
(`src/assets/og/<page>.jpg`), `icon-192.png`, `icon-512.png` and
`favicon.ico` with the site's fonts and the Codex illustration
`src/assets/og/art.png`. Re-run it after changing a page's headline, then
commit the images. Each page's title, description, share image and
structured data (Organization, WebSite, SoftwareApplication, FAQ,
breadcrumbs) are set in `scripts/build-site.mjs`.

## Before launch

1. Fill the `[bracketed]` values in `site.config.mjs` (`check` lists them).
2. Have counsel review `privacy.html` and `terms.html`, and update the
   `legal.*Updated` dates when they change.
3. Make sure the addresses in `contact` exist: support@, sales@, privacy@,
   security@ and legal@berry.me.
4. When the stores approve the app, set `stores.appStore` and
   `stores.playStore`; the pages switch from "Coming soon" to links.
5. When the code is public, set `openSourcePublic: true` and `repository`.

## Hosting

`dist/` deploys to any static host. Pages are written as
`<path>/index.html`, so `/privacy`, `/terms`, `/support`, `/security` and
`/mobile` work with clean URLs; configure the host to serve `404.html` for
unknown paths. The mobile app links to `/privacy`, `/terms` and `/support`
(see `apps/mobile/src/config.ts`), and the store listings use the same URLs.
