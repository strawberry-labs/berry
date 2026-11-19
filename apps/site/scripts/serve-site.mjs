// Serves apps/site/dist on http://127.0.0.1:4321 with clean URLs, for previewing the build.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const port = Number(process.env.PORT ?? 4321);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".xml": "application/xml", ".txt": "text/plain" };

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  let file = resolve(join(dist, path));
  if (!file.startsWith(dist)) file = join(dist, "404.html");
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  const found = existsSync(file);
  const target = found ? file : join(dist, "404.html");
  response.writeHead(found ? 200 : 404, { "Content-Type": types[extname(target)] ?? "application/octet-stream" });
  response.end(readFileSync(target));
}).listen(port, "127.0.0.1", () => console.log(`berry.me preview on http://127.0.0.1:${port}`));
