import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const contentSecurityPolicy = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' https://maps.googleapis.com https://maps.gstatic.com; img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.ggpht.com; connect-src 'self' https://maps.googleapis.com https://maps.gstatic.com; font-src 'self' https://fonts.gstatic.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export async function serveCrmStaticFile(publicRoot, pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const root = resolve(publicRoot);
  const filePath = resolve(root, requested);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    throw Object.assign(new Error("Not found."), { status: 404 });
  }
  const content = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": contentSecurityPolicy,
  });
  response.end(content);
}
