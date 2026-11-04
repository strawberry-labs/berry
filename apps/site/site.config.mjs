// Everything the berry.me pages say about the company, its contacts and the
// legal documents lives here, so a change of name, address or date is made
// once. Values in [brackets] are placeholders that must be filled before the
// site goes public; `node scripts/build-site.mjs --check` lists them.

export const site = {
  name: "Berry",
  domain: "berry.me",
  // Cloudflare Pages serves both berry.me and www.berry.me.
  url: "https://berry.me",
  tagline: "The AI workspace your organization owns",
  description:
    "Berry is the enterprise AI workspace you run yourself: agents that work with your files, tools and data on your infrastructure, with SSO, SCIM, budgets, model governance and audit logs built in.",

  company: {
    legalName: "Strawberry Labs LLC",
    website: "https://strawberrylabs.net",
    shortName: "Berry",
    address: "Sharjah Media City, Sharjah, United Arab Emirates",
    jurisdiction: "the laws of the United Arab Emirates",
    courts: "the competent courts of the United Arab Emirates",
  },

  contact: {
    sales: "admin@strawberrylabs.net",
    support: "admin@strawberrylabs.net",
    privacy: "admin@strawberrylabs.net",
    security: "admin@strawberrylabs.net",
    legal: "admin@strawberrylabs.net",
  },

  analytics: {
    // Google Analytics 4 measurement ID, used by the Google tag in layout.html.
    googleTagId: "G-418DKHLNR9",
  },

  legal: {
    // ISO dates; shown as "Last updated" on each document.
    termsUpdated: "2026-10-19",
    privacyUpdated: "2026-11-04",
  },

  stores: {
    // Set once the listings are live; until then the pages say "coming soon".
    appStore: "",
    playStore: "",
  },

  // Open-source release: false keeps the self-hosting copy as "coming soon".
  openSourcePublic: false,
  repository: "",

  nav: [
    { label: "Agents", href: "/#agents" },
    { label: "Models", href: "/#models" },
    { label: "Governance", href: "/#governance" },
    { label: "Deployment", href: "/#deploy" },
    { label: "Security", href: "/security/" },
    { label: "Mobile", href: "/mobile/" },
  ],
};
