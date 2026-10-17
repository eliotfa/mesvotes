// Point d'entrée : serveur HTTP, fichiers statiques, API et horloge des phases.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { db } from "./db.js";
import { HttpError, sendJson } from "./http.js";
import { handleApi, serveUpload } from "./api.js";
import { ensureConstitution } from "./model.js";
import { tick } from "./lifecycle.js";
import { tickModeration } from "./moderation.js";
import { purgeExpired } from "./auth.js";
import { seedIfEmpty } from "./seed.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json" };

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // Toute autre adresse renvoie l'application (routage côté navigateur).
      if (!path.extname(rel)) return serveStatic(req, res, "/");
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Introuvable."); return;
    }
    const etag = `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": "no-cache", ETag: etag });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      const m = /^\/files\/([a-z0-9]{20})$/.exec(url.pathname);
      if (m) return serveUpload(req, res, m[1]);
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: "Erreur interne. Réessaie dans un instant." });
    }
  });
}

export function boot() {
  ensureConstitution();
  if (config.seedDemo) seedIfEmpty();
  tick();
  tickModeration();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  boot();
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`mesvotes en écoute sur ${config.host}:${config.port} (${config.baseUrl})`);
    console.log(`  e-mails : ${config.mailEnabled ? "SMTP " + config.smtp.host : "désactivés (liens affichés dans ces journaux)"} · mode démo : ${config.demoMode ? "oui" : "non"}`);
  });
  const timer = setInterval(() => {
    try {
      const n = tick(); if (n) console.log(`[horloge] ${n} proposition(s) ont changé de phase`);
      const m = tickModeration(); if (m) console.log(`[horloge] ${m} affaire(s) de modération traitée(s)`);
      purgeExpired();
    }
    catch (e) { console.error("[horloge]", e); }
  }, config.tickSeconds * 1000);
  const stop = () => { clearInterval(timer); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
