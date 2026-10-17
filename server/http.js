// Petits outils HTTP : erreurs, JSON, cookies, corps de requête, limitation de débit.

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `Fichier ou contenu trop volumineux (maximum ${Math.round(limit / 1048576)} Mo).`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); } catch { fail(400, "Requête illisible."); }
}

/**
 * IP du visiteur. Derrière notre proxy, la dernière valeur de X-Forwarded-For est celle qu'il
 * a ajoutée lui-même ; la première peut être fournie par le visiteur, donc falsifiée.
 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const f = req.headers["x-forwarded-for"];
    if (f) return String(f).split(",").pop().trim();
  }
  return req.socket.remoteAddress || "?";
}

const buckets = new Map();
/** true si l'action est autorisée ; sinon lève une 429. */
export function rateLimit(key, max, windowMs, message = "Trop de tentatives. Réessaie dans quelques minutes.") {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  if (++b.count > max) fail(429, message);
  if (buckets.size > 50000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  return true;
}
export const resetRateLimits = () => buckets.clear();
