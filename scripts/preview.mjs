import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
const root = fileURLToPath(new URL("../web/", import.meta.url));
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost"),
        path = resolve(
          root,
          "." +
            decodeURIComponent(
              url.pathname === "/" ? "/index.html" : url.pathname,
            ),
        );
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw 0;
      const b = await readFile(path);
      res.writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html; charset=utf-8",
            ".mjs": "text/javascript",
            ".css": "text/css",
          }[extname(path)] || "application/octet-stream",
      });
      res.end(b);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  })
  .listen(4173, "127.0.0.1", () =>
    console.log("Preview: http://127.0.0.1:4173"),
  );
