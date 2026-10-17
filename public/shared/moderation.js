// Filtre automatique de modération, appliqué côté serveur (et pré-vérifié dans le navigateur).
// Il retient les insultes, les propos haineux, les menaces et les données personnelles.
// Il ne juge jamais une opinion : seulement la forme.

const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "€": "e" };
const norm = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[013457@$€]/g, c => LEET[c]).replace(/(.)\1+/g, "$1");

const INSULTS = new Set(["connard", "connasse", "salope", "salaud", "encule", "enculer", "pute", "batard", "fdp", "ntm",
  "nique", "niquer", "abruti", "debile", "cretin", "tocard", "pd", "pede", "gogol", "trouduc", "pouf", "grognasse"].map(norm));
const HATE = [/\bsale(s)? (arabe|juif|noir|blanc|francais|musulman|chretien|gay|gouine|pd|rebeu|renoi|feuj)/, /\bbougnoule|\bnegre|\byoupin|\bbicot|\bchintok/];
const THREAT = [/\b(je|on) (va|vais|vas) (te|vous|le|la|les) (tuer|buter|crever|defoncer|egorger)/, /\bmort aux?\b/, /\bcreve\b/, /\bje sais ou tu habite/];

/** null si le texte passe, sinon { kind, msg }. */
export function moderate(text, { allowCaps = false } = {}) {
  const raw = String(text || "");
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(raw)) return { kind: "adresse e-mail", msg: "Pas d'adresse e-mail dans les contributions : elles restent publiques." };
  if (/(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/.test(raw)) return { kind: "numéro de téléphone", msg: "Pas de numéro de téléphone : aucune donnée personnelle dans les contributions publiques." };
  const n = norm(raw), words = n.split(/[^a-z]+/).filter(Boolean);
  if (HATE.some(r => r.test(n))) return { kind: "propos haineux", msg: "Ce message vise un groupe de personnes pour ce qu'elles sont. C'est exclu de la plateforme, quelle que soit l'opinion défendue." };
  if (THREAT.some(r => r.test(n))) return { kind: "menace", msg: "Ce message contient une menace. Il n'est pas publié." };
  if (words.some(w => INSULTS.has(w))) return { kind: "insulte", msg: "Ce message contient une insulte. Reformule pour critiquer l'idée, pas la personne : c'est aussi plus convaincant." };
  if (!allowCaps) {
    const letters = raw.replace(/[^A-Za-zÀ-ÿ]/g, "");
    if (letters.length > 24 && letters.replace(/[^A-ZÀ-Þ]/g, "").length / letters.length > 0.7)
      return { kind: "majuscules", msg: "Écrire tout en majuscules, c'est crier. Réécris en minuscules et ton argument sera mieux lu." };
  }
  return null;
}
