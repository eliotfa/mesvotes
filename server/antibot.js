// Anti-robot sans service extérieur : preuve de travail + délai minimum + champ piège.
//
// 1. Le serveur fournit un défi signé (sel aléatoire, date, difficulté).
// 2. Le navigateur cherche un nombre tel que SHA-256(sel + nombre) commence par N bits à zéro.
//    Pour un humain c'est invisible (quelques centaines de millisecondes pendant qu'il tape) ;
//    pour un robot qui crée des milliers de comptes, ça coûte cher.
// 3. Le formulaire contient un champ caché « site web » : un humain ne le voit pas, un robot le remplit.
// 4. Un formulaire envoyé trop vite après l'affichage du défi est refusé.
import crypto from "node:crypto";
import { fail } from "./http.js";
import { now } from "./model.js";

const SECRET = process.env.ANTIBOT_SECRET || crypto.randomBytes(32).toString("hex");
const BITS = Number(process.env.ANTIBOT_BITS || 17);
const MIN_MS = Number(process.env.ANTIBOT_MIN_SECONDS ?? 2) * 1000;
const MAX_MS = 60 * 60 * 1000;
const used = new Map(); // sels déjà utilisés → date d'expiration

const sign = (salt, ts, bits) => crypto.createHmac("sha256", SECRET).update(`${salt}.${ts}.${bits}`).digest("hex");

export function challenge() {
  const salt = crypto.randomBytes(12).toString("hex"), ts = now();
  return { salt, ts, bits: BITS, sig: sign(salt, ts, BITS) };
}

function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) { if (byte === 0) { n += 8; continue; } n += Math.clz32(byte) - 24; break; }
  return n;
}

const GENERIC = "La vérification anti-robot a échoué. Recharge la page et réessaie.";

/** Vérifie la preuve envoyée avec un formulaire ; lève une erreur 400 sinon. */
export function verify(body, { minMs = MIN_MS } = {}) {
  if (body && String(body.nepasremplir || "").trim()) fail(400, GENERIC); // champ piège rempli
  const a = body && body.antibot;
  if (!a || typeof a !== "object") fail(400, GENERIC);
  const salt = String(a.salt || ""), ts = Number(a.ts), bits = Number(a.bits), nonce = String(a.nonce ?? "");
  if (!/^[0-9a-f]{24}$/.test(salt) || !Number.isFinite(ts) || bits < BITS || !/^\d{1,12}$/.test(nonce)) fail(400, GENERIC);
  const expected = sign(salt, ts, bits);
  const given = String(a.sig || "");
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) fail(400, GENERIC);
  const age = now() - ts;
  if (age < minMs) fail(400, "Doucement : prends quelques secondes pour remplir le formulaire, puis réessaie.");
  if (age > MAX_MS) fail(400, "Le formulaire a expiré. Recharge la page et réessaie.");
  if (used.has(salt)) fail(400, GENERIC);
  if (leadingZeroBits(crypto.createHash("sha256").update(salt + nonce).digest()) < bits) fail(400, GENERIC);
  used.set(salt, ts + MAX_MS);
  if (used.size > 10000) { const t = now(); for (const [k, exp] of used) if (exp < t) used.delete(k); }
}
