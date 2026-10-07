// Zero-dependency static server for local testing:  node tools/serve.mjs [port]
// (The site needs http(s): module workers and crypto.subtle don't work from file://.)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const port = Number(process.argv[2]) || 8080;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(root, url.endsWith("/") ? url + "index.html" : url);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  });
}).listen(port, "127.0.0.1", () => console.log(`Conker Asset Explorer: http://localhost:${port}/`));
