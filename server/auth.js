// Comptes : mots de passe (scrypt), sessions par cookie, jetons d'e-mail.
import crypto from "node:crypto";
import { q } from "./db.js";
import { config } from "./config.js";
import { parseCookies } from "./http.js";

const COOKIE = "mv_session";
const SESSION_DAYS = 30;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
export function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, saltHex, hashHex] = stored.split("$");
  const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 });
  const ref = Buffer.from(hashHex, "hex");
  return ref.length === hash.length && crypto.timingSafeEqual(ref, hash);
}
// Calcul factice pour garder un temps de réponse constant quand l'e-mail n'existe pas.
const DUMMY = hashPassword("mesvotes-dummy");
export const burnTime = pw => verifyPassword(pw, DUMMY);

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = () => crypto.randomBytes(32).toString("base64url");

export function createSession(res, userId) {
  const token = randomToken(), now = Date.now();
  q("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)").run(sha(token), userId, now, now + SESSION_DAYS * 864e5);
  setCookie(res, token, SESSION_DAYS * 86400);
}
export function destroySession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) q("DELETE FROM sessions WHERE token_hash=?").run(sha(t));
  setCookie(res, "", 0);
}
function setCookie(res, value, maxAge) {
  const parts = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (config.cookieSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

/** Utilisateur connecté (ou null). */
export function currentUser(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const row = q(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(sha(t), Date.now());
  if (!row || row.banned) return null;
  return row;
}
export const revokeSessions = userId => q("DELETE FROM sessions WHERE user_id=?").run(userId);

export function createToken(userId, purpose, hours) {
  const token = randomToken();
  q("DELETE FROM tokens WHERE user_id=? AND purpose=?").run(userId, purpose);
  q("INSERT INTO tokens(token_hash,user_id,purpose,expires_at) VALUES (?,?,?,?)").run(sha(token), userId, purpose, Date.now() + hours * 3600e3);
  return token;
}
export function consumeToken(token, purpose) {
  const row = q("SELECT * FROM tokens WHERE token_hash=? AND purpose=?").get(sha(String(token || "")), purpose);
  if (!row) return null;
  q("DELETE FROM tokens WHERE token_hash=?").run(row.token_hash);
  return row.expires_at > Date.now() ? row.user_id : null;
}

export function purgeExpired() {
  const now = Date.now();
  q("DELETE FROM sessions WHERE expires_at<?").run(now);
  q("DELETE FROM tokens WHERE expires_at<?").run(now);
}
