// Renders the berry.me share images (1200 × 630, one per page) and the app
// icons with the site's own fonts, colours and art, using Playwright.
//   node apps/site/scripts/og-images.mjs
// Output goes to apps/site/src/assets (og/*.jpg, icon-192.png, icon-512.png,
// favicon.ico); commit the results. The illustration on the right is
// src/assets/og/art.png, made with Codex image generation.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "../..");
const assets = join(appDir, "src", "assets");
// Playwright comes from the web app's dev dependencies.
const { chromium } = createRequire(join(repoRoot, "apps/web/package.json"))("@playwright/test");

const file = (path) => pathToFileURL(join(assets, path)).href;

const CARDS = [
  { name: "home", label: "Enterprise AI workspace", lead: "The AI workspace", accent: "your organization owns.", sub: "Agents that work with your files, tools and data. On your infrastructure, with your models, under your rules." },
  { name: "security", label: "Security and trust", lead: "Built so your data", accent: "never has to leave.", sub: "Tenant isolation, sandboxed code, SSO and SCIM, encrypted secrets and a full audit trail." },
  { name: "mobile", label: "iPhone and Android", lead: "Follow the work", accent: "from anywhere.", sub: "Start tasks, watch the agent work and answer its questions from your phone." },
  { name: "support", label: "Support", lead: "How can we", accent: "help?", sub: "Signing in, lost phones, accounts and reaching the Berry team." },
  { name: "privacy", label: "Legal", lead: "Privacy", accent: "policy.", sub: "How Strawberry Labs handles personal information across Berry, the app and berry.me." },
  { name: "terms", label: "Legal", lead: "Terms of", accent: "service.", sub: "The terms for using Berry, the Berry mobile app and berry.me." },
];

const chips = ["Self-hosted", "SSO & SCIM", "Your models", "Every action audited"];

function cardHtml(card) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: Jakarta; src: url("${file("fonts/plus-jakarta-sans.woff2")}"); font-weight: 200 800; }
  @font-face { font-family: Mono; src: url("${file("fonts/geist-mono.woff2")}"); font-weight: 100 900; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1200px; height: 630px; background: #0c0b0b; overflow: hidden; }
  body { position: relative; font-family: Jakarta, sans-serif; color: #f5f3f1; }
  .grid { position: absolute; inset: 0; background-image: linear-gradient(#1c1919 1px, transparent 1px), linear-gradient(90deg, #1c1919 1px, transparent 1px); background-size: 60px 60px; background-position: -1px -1px; }
  .glow { position: absolute; right: -120px; bottom: -160px; width: 760px; height: 620px; background: radial-gradient(closest-side, rgb(236 43 69 / 0.22), transparent); }
  .cross { position: absolute; width: 13px; height: 13px; }
  .cross::before, .cross::after { content: ""; position: absolute; background: #ec2b45; }
  .cross::before { left: 6px; top: 0; width: 1px; height: 13px; }
  .cross::after { top: 6px; left: 0; height: 1px; width: 13px; }
  .frame { position: absolute; inset: 36px; border: 1px solid #2a2626; border-radius: 22px; }
  .art { position: absolute; right: 26px; top: 47%; width: 500px; height: 500px; transform: translateY(-50%); object-fit: contain; -webkit-mask-image: radial-gradient(closest-side, #000 70%, transparent); }
  .content { position: absolute; left: 84px; top: 82px; width: 660px; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 700; letter-spacing: -0.03em; }
  .brand img { width: 24px; }
  .label { margin-top: 50px; font-family: Mono, monospace; font-size: 16px; letter-spacing: 0.16em; text-transform: uppercase; color: #a6a09c; display: flex; align-items: center; gap: 12px; }
  .label i { width: 9px; height: 9px; background: #ec2b45; }
  h1 { margin-top: 18px; font-size: 60px; line-height: 1.0; letter-spacing: -0.05em; font-weight: 700; }
  h1 span { display: block; color: #ec2b45; }
  p { margin-top: 22px; font-size: 22px; line-height: 1.45; color: #a6a09c; max-width: 560px; }
  .chips { position: absolute; left: 84px; bottom: 74px; display: flex; gap: 10px; }
  .chip { font-family: Mono, monospace; font-size: 15px; color: #d6d1cd; padding: 8px 14px; border-radius: 9px; background: rgb(255 255 255 / 0.04); box-shadow: inset 0 0 0 1px #363232; display: flex; align-items: center; gap: 8px; }
  .chip i { width: 6px; height: 6px; background: #ec2b45; }
  .url { position: absolute; right: 84px; bottom: 80px; font-family: Mono, monospace; font-size: 18px; color: #6e6966; letter-spacing: 0.04em; }
  </style></head><body>
  <div class="grid"></div><div class="glow"></div>
  <img class="art" src="${file("og/art.png")}" alt="">
  <div class="frame"></div>
  <span class="cross" style="left: 30px; top: 30px"></span><span class="cross" style="right: 30px; top: 30px"></span>
  <span class="cross" style="left: 30px; bottom: 30px"></span><span class="cross" style="right: 30px; bottom: 30px"></span>
  <div class="content">
    <div class="brand"><img src="${file("berry-logo.svg")}" alt="">Berry</div>
    <div class="label"><i></i>${card.label}</div>
    <h1>${card.lead}<span>${card.accent}</span></h1>
    <p>${card.sub}</p>
  </div>
  <div class="chips">${chips.map((chip) => `<span class="chip"><i></i>${chip}</span>`).join("")}</div>
  <div class="url">berry.me</div>
  </body></html>`;
}

function iconHtml(size) {
  return `<!doctype html><html><head><style>
  * { margin: 0; } html, body { width: ${size}px; height: ${size}px; background: #0c0b0b; display: grid; place-items: center; }
  img { width: ${Math.round(size * 0.42)}px; height: auto; }
  </style></head><body><img src="${file("berry-logo.svg")}" alt=""></body></html>`;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  mkdirSync(join(assets, "og"), { recursive: true });
  for (const card of CARDS) {
    const tmp = join(assets, "og", `.${card.name}.html`);
    writeFileSync(tmp, cardHtml(card));
    await page.goto(pathToFileURL(tmp).href);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(assets, "og", `${card.name}.jpg`), type: "jpeg", quality: 90 });
    rmSync(tmp);
    console.log(`og/${card.name}.jpg`);
  }
  for (const size of [192, 512, 32]) {
    const icon = await browser.newPage({ viewport: { width: size, height: size } });
    const tmp = join(assets, `.icon-${size}.html`);
    writeFileSync(tmp, iconHtml(size));
    await icon.goto(pathToFileURL(tmp).href);
    const out = size === 32 ? join(assets, ".favicon-32.png") : join(assets, `icon-${size}.png`);
    await icon.screenshot({ path: out });
    rmSync(tmp);
    await icon.close();
    console.log(out.replace(`${assets}/`, ""));
  }
} finally {
  await browser.close();
}

/** A one-image .ico that embeds the 32px PNG (supported by every browser). */
function writeIco(pngPath, icoPath) {
  const png = readFileSync(pngPath);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(32, 6);
  header.writeUInt8(32, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  writeFileSync(icoPath, Buffer.concat([header, png]));
  rmSync(pngPath);
}
writeIco(join(assets, ".favicon-32.png"), join(assets, "favicon.ico"));
console.log("favicon.ico");
