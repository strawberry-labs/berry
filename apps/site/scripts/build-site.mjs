// Builds the berry.me marketing and legal pages into apps/site/dist: plain
// HTML and CSS plus one small first-party script for motion, no client
// framework and no third-party fonts; the only third-party script is the
// Google tag (layout.html), which the CSP below allows. Pixel icons and
// illustrations are drawn in code (src/art.mjs) at build time.
// `--check` only reports placeholders that must be filled before launch.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { site } from "../site.config.mjs";
import { art, icon } from "../src/art.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(appDir, "src");
const dist = join(appDir, "dist");

// Every indexable page has its own title, description and share image
// (src/assets/og/<og>.jpg, made by scripts/og-images.mjs).
const PAGES = [
  {
    source: "index.html", output: "index.html", path: "/", og: "home",
    title: `${site.name}: the enterprise AI workspace your organization owns`,
    description: "Berry is the self-hosted enterprise AI workspace: agents that work with your files, tools and models, with SSO, SCIM, budgets and audit logs built in.",
  },
  {
    source: "security.html", output: "security/index.html", path: "/security/", og: "security", crumb: "Security",
    title: `Security and trust · ${site.name}`,
    description: "How Berry keeps your data inside your boundary: row-level tenant isolation, sandboxed code, SSO and SCIM, encrypted secrets and a full audit trail.",
  },
  {
    source: "mobile.html", output: "mobile/index.html", path: "/mobile/", og: "mobile", crumb: "Mobile app",
    title: `Berry for iPhone and Android · ${site.name}`,
    description: "Follow your organization's Berry from your phone: start tasks, watch the agent work and answer its questions. Sign in with a QR code from the web.",
  },
  {
    source: "support.html", output: "support/index.html", path: "/support/", og: "support", crumb: "Support",
    title: `Support · ${site.name}`,
    description: "Get help with Berry on the web, desktop and phone: signing in, signing out a lost phone, deleting your account and reaching the Berry team.",
  },
  {
    source: "privacy.html", output: "privacy/index.html", path: "/privacy/", og: "privacy", crumb: "Privacy policy",
    title: `Privacy policy · ${site.name}`,
    description: "How Strawberry Labs handles personal information across self-hosted and managed Berry, the Berry mobile app and berry.me.",
  },
  {
    source: "terms.html", output: "terms/index.html", path: "/terms/", og: "terms", crumb: "Terms of service",
    title: `Terms of service · ${site.name}`,
    description: "The terms for using Berry, the Berry mobile app and berry.me, provided by Strawberry Labs LLC.",
  },
  {
    source: "404.html", output: "404.html", path: "/404", og: "home", noindex: true,
    title: `Page not found · ${site.name}`,
    description: "This page doesn't exist. Head back to Berry, the enterprise AI workspace your organization owns.",
  },
];

const BUILD_DATE = new Date().toISOString().slice(0, 10);

/** Questions and answers from a page's <details class="faq"> blocks. */
function faqs(html) {
  const strip = (text) => text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return [...html.matchAll(/<details class="faq"><summary>([\s\S]*?)<\/summary><div>([\s\S]*?)<\/div><\/details>/g)]
    .map(([, q, a]) => ({ "@type": "Question", name: strip(q), acceptedAnswer: { "@type": "Answer", text: strip(a) } }));
}

/** schema.org JSON-LD for a page: organization and site everywhere, plus page specifics. */
function structuredData(page, body) {
  const url = `${site.url}${page.path}`;
  const org = {
    "@type": "Organization",
    "@id": `${site.url}/#organization`,
    name: site.company.legalName,
    brand: { "@type": "Brand", name: site.name },
    url: site.company.website,
    logo: `${site.url}/assets/icon-512.png`,
    email: site.contact.support,
    address: { "@type": "PostalAddress", addressLocality: "Sharjah Media City, Sharjah", addressCountry: "AE" },
  };
  const website = { "@type": "WebSite", "@id": `${site.url}/#website`, url: `${site.url}/`, name: site.name, publisher: { "@id": `${site.url}/#organization` }, inLanguage: "en" };
  const webpage = {
    "@type": "WebPage",
    "@id": `${url}#webpage`, url, name: page.title, description: page.description,
    isPartOf: { "@id": `${site.url}/#website` }, inLanguage: "en", dateModified: BUILD_DATE,
    primaryImageOfPage: { "@type": "ImageObject", url: `${site.url}/assets/og/${page.og}.jpg`, width: 1200, height: 630 },
  };
  const graph = [org, website, webpage];
  if (page.path === "/") {
    graph.push({
      "@type": "SoftwareApplication",
      "@id": `${site.url}/#software`,
      name: site.name,
      applicationCategory: "BusinessApplication",
      applicationSubCategory: "Enterprise AI workspace",
      operatingSystem: "Web, macOS, Windows, iOS, Android, Linux (self-hosted)",
      description: page.description,
      url: `${site.url}/`,
      image: `${site.url}/assets/og/home.jpg`,
      publisher: { "@id": `${site.url}/#organization` },
      featureList: [
        "AI agents with tool calling, file reading and code execution in sandboxes",
        "Bring your own models: OpenAI, Anthropic, OpenAI-compatible endpoints, Ollama, LM Studio or Berry Router",
        "Scheduled tasks, connectors and MCP servers",
        "Google Workspace single sign-on and SCIM 2.0 provisioning",
        "Role-based access, model governance, budgets and audit logs",
        "Self-hosted with Docker Compose, Helm or AWS, or a dedicated instance",
      ],
    });
  }
  if (page.crumb) {
    graph.push({ "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: site.name, item: `${site.url}/` },
      { "@type": "ListItem", position: 2, name: page.crumb, item: url },
    ] });
  }
  const questions = faqs(body);
  if (questions.length) graph.push({ "@type": "FAQPage", "@id": `${url}#faq`, mainEntity: questions });
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

/** The <head> metadata for one page. */
function head(page, body) {
  const url = `${site.url}${page.path === "/404" ? "/" : page.path}`;
  const image = `${site.url}/assets/og/${page.og}.jpg`;
  const alt = `${site.name}: the enterprise AI workspace your organization owns`;
  const e = escapeHtml;
  return [
    `  <title>${e(page.title)}</title>`,
    `  <meta name="description" content="${e(page.description)}">`,
    page.noindex ? `  <meta name="robots" content="noindex">` : `  <link rel="canonical" href="${e(url)}">\n  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">`,
    `  <meta name="theme-color" content="#0c0b0b">`,
    `  <meta name="color-scheme" content="dark">`,
    `  <meta name="author" content="${e(site.company.legalName)}">`,
    `  <meta name="application-name" content="${e(site.name)}">`,
    `  <meta property="og:type" content="website">`,
    `  <meta property="og:site_name" content="${e(site.name)}">`,
    `  <meta property="og:locale" content="en_US">`,
    `  <meta property="og:title" content="${e(page.title)}">`,
    `  <meta property="og:description" content="${e(page.description)}">`,
    `  <meta property="og:url" content="${e(url)}">`,
    `  <meta property="og:image" content="${e(image)}">`,
    `  <meta property="og:image:secure_url" content="${e(image)}">`,
    `  <meta property="og:image:type" content="image/jpeg">`,
    `  <meta property="og:image:width" content="1200">`,
    `  <meta property="og:image:height" content="630">`,
    `  <meta property="og:image:alt" content="${e(alt)}">`,
    `  <meta name="twitter:card" content="summary_large_image">`,
    `  <meta name="twitter:title" content="${e(page.title)}">`,
    `  <meta name="twitter:description" content="${e(page.description)}">`,
    `  <meta name="twitter:image" content="${e(image)}">`,
    `  <meta name="twitter:image:alt" content="${e(alt)}">`,
    page.noindex ? "" : `  <script type="application/ld+json">${structuredData(page, body)}</script>`,
  ].filter(Boolean).join("\n");
}

/** Placeholders still in the config, as "path: value". */
function placeholders(value = site, prefix = "site") {
  if (typeof value === "string") return /^\[.*\]$/.test(value) ? [`${prefix}: ${value}`] : [];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => placeholders(child, `${prefix}.${key}`));
}

if (process.argv.includes("--check")) {
  const missing = placeholders();
  if (missing.length === 0) console.log("site.config.mjs: no placeholders left");
  else console.log(`site.config.mjs has ${missing.length} placeholder(s) to fill before launch:\n  ${missing.join("\n  ")}`);
  process.exit(0);
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const formatDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function storeLinks() {
  const badge = (href, file, label, width) => {
    const img = `<img src="/assets/${file}" alt="${label}" width="${width}" height="40">`;
    return href
      ? `<a class="store-badge" href="${escapeHtml(href)}">${img}</a>`
      : `<span class="store-badge is-soon" aria-label="${label}, coming soon">${img}<small>Coming soon</small></span>`;
  };
  return `${badge(site.stores.appStore, "app-store-badge.svg", "Download on the App Store", 120)}${badge(site.stores.playStore, "google-play-badge.svg", "Get it on Google Play", 135)}`;
}

/** Values pages can use as {{name}}; dotted names read site.config.mjs. */
const derived = {
  year: String(new Date().getUTCFullYear()),
  "terms.updated": formatDate(site.legal.termsUpdated),
  "privacy.updated": formatDate(site.legal.privacyUpdated),
  "stores.links": storeLinks(),
  "selfHost.label": site.openSourcePublic ? "Self-host Berry" : "Self-hosting: early access",
  "selfHost.href": site.openSourcePublic && site.repository ? site.repository : `mailto:${site.contact.sales}?subject=Berry%20self-hosting%20early%20access`,
  "selfHost.note": site.openSourcePublic ? "Open source. Run it with Docker Compose or Helm." : "Open-source release coming soon. Early-access teams run it today with Docker Compose or Helm.",
};

/** Derived values are trusted HTML; config values are escaped. */
function lookup(name) {
  if (name in derived) return derived[name];
  if (name.startsWith("px:")) return icon(name.slice(3));
  if (name.startsWith("art:")) return art(name.slice(4));
  const value = name.split(".").reduce((node, key) => (node == null ? undefined : node[key]), site);
  if (value === undefined || typeof value === "object") throw new Error(`Unknown template value {{${name}}}`);
  return escapeHtml(value);
}

function fill(template) {
  return template.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (_, name) => lookup(name));
}

const layout = readFileSync(join(src, "layout.html"), "utf8");
const nav = site.nav.map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`).join("");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const page of PAGES) {
  const body = fill(readFileSync(join(src, "pages", page.source), "utf8"));
  const html = fill(layout)
    .replace("<!--head-->", head(page, body))
    .replaceAll("<!--nav-->", nav)
    .replace("<!--content-->", body);
  if (/\{\{|\}\}/.test(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ""))) throw new Error(`${page.source}: unfilled template braces`);
  const out = join(dist, page.output);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
}

cpSync(join(src, "styles.css"), join(dist, "styles.css"));
cpSync(join(src, "site.js"), join(dist, "site.js"));
if (existsSync(join(src, "assets"))) cpSync(join(src, "assets"), join(dist, "assets"), { recursive: true });
// Cloudflare Pages headers: long cache for fingerprint-free but stable assets
// (fonts, icons, logos), short cache for pages, and basic security headers.
writeFileSync(join(dist, "_headers"), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: default-src 'self'; img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://*.googletagmanager.com; font-src 'self'; connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
/assets/*
  Cache-Control: public, max-age=604800
/assets/fonts/*
  Cache-Control: public, max-age=31536000, immutable
`);
writeFileSync(join(dist, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${site.url}/sitemap.xml\n`);
writeFileSync(join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.filter((page) => !page.noindex).map((page) => `  <url><loc>${site.url}${page.path}</loc><lastmod>${BUILD_DATE}</lastmod><priority>${page.path === "/" ? "1.0" : "0.6"}</priority></url>`).join("\n")}\n</urlset>\n`);
writeFileSync(join(dist, "site.webmanifest"), JSON.stringify({
  name: site.name,
  short_name: site.name,
  description: PAGES[0].description,
  start_url: "/",
  display: "browser",
  background_color: "#0c0b0b",
  theme_color: "#0c0b0b",
  icons: [
    { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
}, null, 2));
if (existsSync(join(src, "assets", "favicon.ico"))) cpSync(join(src, "assets", "favicon.ico"), join(dist, "favicon.ico"));

const missing = placeholders();
console.log(`built ${PAGES.length} pages and ${readdirSync(join(dist, "assets")).length} assets in apps/site/dist`);
if (missing.length) console.log(`note: ${missing.length} placeholder(s) in site.config.mjs (run with --check to list them)`);
