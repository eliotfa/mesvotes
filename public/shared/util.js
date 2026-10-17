// Utilitaires partagés entre le navigateur et le serveur (aucune dépendance).

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Découpe un texte en paragraphes (séparés par une ligne vide). */
export const paras = t => String(t || "").split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);

/** Recompose un texte propre à partir de ses paragraphes. */
export const normText = t => paras(t).join("\n\n");

/** Minuscule + sans accents, pour la recherche. */
export const normQ = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function normTag(t) {
  return String(t).toLowerCase().trim().replace(/^#/, "").replace(/[^a-z0-9à-ÿ-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}

/** "transparence, #élus open-data" → ["transparence","élus","open-data"] (6 max). */
export function parseTags(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(/[,\s#]+/);
  return [...new Set(list.map(normTag).filter(t => t.length >= 2))].slice(0, 6);
}

export const THEMES = ["Constitution", "Institutions", "Économie", "Écologie", "Éducation", "Santé", "Transports", "Justice", "Social", "Culture"];

export const PHASES = [
  { id: "projet", name: "Projet", c: "--ph-projet" },
  { id: "parrainage", name: "Parrainage", c: "--ph-parrainage" },
  { id: "deliberation", name: "Délibération", c: "--ph-deliberation" },
  { id: "vote", name: "Vote", c: "--ph-vote" },
  { id: "fin", name: "Résultat", c: "--ph-fin" }
];
export const PHASE_INDEX = Object.fromEntries(PHASES.map((p, i) => [p.id, i]));

export const KINDS = {
  loi: { label: "Nouvelle loi", desc: "Proposer un texte qui n'existe pas encore." },
  modif: { label: "Modification", desc: "Améliorer une loi déjà adoptée, version par version." },
  abrog: { label: "Abrogation", desc: "Supprimer une loi adoptée qui ne convient plus." },
  const: { label: "Constitution", desc: "Changer les règles du jeu : durées, seuils, principes." }
};

export const DAY = 864e5;
