// 极简静态服务器（无依赖）。ES 模块不能用 file:// 加载，所以原型需要一个 http 服务。
//   node serve.mjs           → 默认端口 8000
//   node serve.mjs 8123      → 指定端口
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let file = path.join(root, url === "/" ? "/couzin-command.html" : url);

  if (!file.startsWith(root)) { res.writeHead(403); res.end("forbidden"); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("404 " + url); return; }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
}).listen(port, "127.0.0.1", () => {
  console.log("serving " + root);
  console.log("http://127.0.0.1:" + port + "/couzin-command.html");
});
