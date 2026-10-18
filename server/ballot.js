// Secret du vote : qui a voté (registre de participation) est séparé de ce qui a été voté (urne).
// L'urne ne contient ni compte, ni date, ni ordre d'arrivée : chaque bulletin est rangé sous
// l'empreinte d'un code de vote remis une seule fois à l'électeur. Sans ce code, personne
// (administration comprise) ne peut retrouver le bulletin d'une personne, ni le modifier.
import crypto from "node:crypto";
import { fail } from "./http.js";

const ALPHA = "ABCDEFGHIJKMNPQRSTUVWXYZ23456789"; // 32 signes, sans 0/O ni 1/L/l : 5 bits chacun
const DAY = 864e5;

/** Nouveau code de vote : 20 signes (100 bits), lisible par groupes de 5. */
export function newReceipt() {
  const b = crypto.randomBytes(20);
  return Array.from(b, x => ALPHA[x % 32]).join("").replace(/(.{5})(?=.)/g, "$1-");
}

/** Empreinte stockée dans l'urne. Tolère minuscules, espaces et tirets à la saisie. */
export function receiptHash(code) {
  const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 20 || [...c].some(x => !ALPHA.includes(x))) fail(400, "Code de vote invalide : il fait 20 signes, par exemple ABCDE-FGHJK-MNPQR-STUVW.");
  return crypto.createHash("sha256").update(c).digest("hex");
}

/** Date de participation arrondie au jour : assez pour la transparence, trop floue pour un recoupement. */
export const dayOf = ts => Math.floor(ts / DAY) * DAY;

/** En dessous de ce nombre de votants mineurs, leur décompte n'est pas publié à part. */
export const MINOR_MIN = 5;
