// La Constitution de mesvotes : règles chiffrées + textes de principe.
// Ce module est la source unique de vérité, utilisée par le serveur et l'interface.
import { diffView } from "./diff.js";

export const PARAMS = [
  { k: "projetMin", l: "Phase Projet : durée minimum", u: "jours", min: 1, max: 365 },
  { k: "projetMax", l: "Phase Projet : durée maximum", u: "jours", min: 1, max: 365 },
  { k: "parrainagePct", l: "Parrainage : part des inscrits", u: "%", min: 0.1, max: 50, step: 0.1 },
  { k: "parrainageMin", l: "Parrainage : minimum de parrains", u: "parrains", min: 1, max: 1000000 },
  { k: "parrainageDays", l: "Parrainage : délai pour les réunir", u: "jours", min: 1, max: 365 },
  { k: "delibMin", l: "Délibération : durée minimum", u: "jours", min: 1, max: 730 },
  { k: "delibMax", l: "Délibération : durée maximum", u: "jours", min: 1, max: 730 },
  { k: "voteDays", l: "Vote : durée", u: "jours", min: 1, max: 60 },
  { k: "majorityPct", l: "Loi : majorité requise", u: "% des exprimés", min: 50, max: 95 },
  { k: "quorumPct", l: "Loi : participation minimum", u: "% des inscrits", min: 0, max: 100 },
  { k: "constMajorityPct", l: "Révision : majorité requise", u: "% des exprimés", min: 50, max: 95 },
  { k: "constQuorumPct", l: "Révision : participation minimum", u: "% des inscrits", min: 0, max: 100 },
  { k: "modReports", l: "Modération : signalements pour ouvrir une affaire", u: "signalements", min: 1, max: 100 },
  { k: "modJury", l: "Modération : jurés tirés au sort", u: "jurés", min: 3, max: 51 },
  { k: "modHours", l: "Modération : délai pour juger", u: "heures", min: 6, max: 720 },
  { k: "modDelVotes", l: "Modération : votes pour supprimer un contenu masqué", u: "votes", min: 3, max: 100 },
  { k: "codeDays", l: "Codes : durée du vote sur une demande", u: "jours", min: 1, max: 60 },
  { k: "codeMinVotes", l: "Codes : votes minimum pour valider une demande", u: "votes", min: 1, max: 100000 }
];
export const PMETA = Object.fromEntries(PARAMS.map(p => [p.k, p]));
export const FREE_KEYS = [["preambule", "Préambule"], ["principes", "Article 1 · Principes"], ["charte", "Article 9 · Charte du débat"]];

/** Mesures possibles d'un jury, de la plus légère à la plus sévère. */
export const MOD_ACTIONS = [
  { id: "keep", sev: 0, label: "Ne rien faire", desc: "Le signalement n'est pas fondé. Tout reste en place." },
  { id: "hide", sev: 1, label: "Masquer le contenu", desc: "Le contenu est retiré de la vue publique. Pas de sanction pour l'auteur." },
  { id: "warn", sev: 2, label: "Masquer et avertir", desc: "Le contenu est retiré et l'auteur reçoit un avertissement." },
  { id: "suspend7", sev: 3, label: "Masquer et suspendre 7 jours", desc: "L'auteur peut lire mais plus participer pendant 7 jours." },
  { id: "suspend30", sev: 4, label: "Masquer et suspendre 30 jours", desc: "L'auteur peut lire mais plus participer pendant 30 jours." },
  { id: "ban", sev: 5, label: "Exclure définitivement", desc: "Le compte est fermé. Réservé aux abus graves ou répétés." }
];
/** Pour un compte signalé, il n'y a pas de contenu à masquer. */
export const actionsFor = type => type === "user"
  ? MOD_ACTIONS.filter(a => a.id !== "hide").map(a => a.id === "warn" ? { ...a, label: "Avertir", desc: "Le compte reçoit un avertissement." } : a.id === "suspend7" ? { ...a, label: "Suspendre 7 jours" } : a.id === "suspend30" ? { ...a, label: "Suspendre 30 jours" } : a)
  : MOD_ACTIONS;
export const REPORT_REASONS = [
  ["insulte", "Insulte ou attaque personnelle"], ["harcelement", "Harcèlement"], ["haine", "Propos haineux ou discriminatoires"],
  ["menace", "Menace ou appel à la violence"], ["donnees", "Données personnelles"], ["spam", "Spam ou publicité"],
  ["fausse-info", "Fausse information manifeste"], ["hors-sujet", "Hors sujet ou doublon"], ["illegal", "Contenu illégal"], ["autre", "Autre"]
];

/** Complète un état ancien avec les règles ajoutées depuis (valeurs par défaut). */
export const normalizeCst = c => c && ({ ...c, params: { ...DEFAULT_PARAMS, ...(c.params || {}) }, free: { ...DEFAULT_FREE, ...(c.free || {}) } });

export const DEFAULT_PARAMS = {
  projetMin: 15, projetMax: 90, parrainagePct: 1, parrainageMin: 50, parrainageDays: 60,
  delibMin: 90, delibMax: 180, voteDays: 7, majorityPct: 50, quorumPct: 5, constMajorityPct: 60, constQuorumPct: 10,
  modReports: 3, modJury: 7, modHours: 72, modDelVotes: 5, codeDays: 7, codeMinVotes: 5
};
export const DEFAULT_FREE = {
  preambule: "Nous, citoyennes et citoyens, voulons voter pour des idées et non pour des personnes. La présente Constitution fixe les règles par lesquelles nous proposons, débattons et adoptons nos lois. Elle peut elle-même être révisée par tous.",
  principes: "Chaque inscrit dispose d'une voix, quel que soit son âge. Tout débat est public et chaque texte garde la trace de toutes ses versions. Aucune proposition ne peut contourner les étapes prévues par la présente Constitution.",
  charte: "On débat des idées, jamais des personnes. Les insultes, les propos haineux, les menaces et la publication de données personnelles sont interdits. Un filtre automatique retient ces contenus. Les autres manquements sont signalés et jugés par les inscrits eux-mêmes, selon l'article 10."
};

export const n_ = v => String(v).replace(".", ",");
export const fmtParam = (k, v) => `${n_(v)} ${PMETA[k].u}`;

export function constArticles(c) {
  const p = c.params, f = c.free;
  return [
    { key: "preambule", title: "Préambule", body: f.preambule },
    { key: "principes", title: "Article 1 · Principes", body: f.principes },
    { key: "projet", title: "Article 2 · Phase Projet", body: `Toute personne inscrite peut déposer une proposition. Son porteur choisit la durée de la phase Projet, entre ${p.projetMin} et ${p.projetMax} jours. Pendant cette phase, chacun peut commenter, sourcer et proposer des amendements ; le porteur décide de les intégrer ou non. Chaque version du texte est conservée.` },
    { key: "parrainage", title: "Article 3 · Parrainage", body: `À la fin de la phase Projet, le texte est figé. Il doit réunir ${n_(p.parrainagePct)} % des inscrits, avec un minimum de ${p.parrainageMin} parrains, dans un délai de ${p.parrainageDays} jours. À défaut, la proposition est archivée.` },
    { key: "deliberation", title: "Article 4 · Délibération", body: `Une proposition parrainée est soumise à une délibération publique dont le porteur choisit la durée, entre ${p.delibMin} et ${p.delibMax} jours. Le texte ne peut plus être modifié.` },
    { key: "vote", title: "Article 5 · Vote", body: `Le vote dure ${p.voteDays} jours. Chaque inscrit vote pour, contre ou s'abstient, et peut modifier son vote jusqu'à la clôture. Les résultats ne sont publiés qu'à la clôture.` },
    { key: "adoption", title: "Article 6 · Adoption", body: `Une loi est adoptée si les voix « pour » représentent plus de ${n_(p.majorityPct)} % des suffrages exprimés, et si au moins ${n_(p.quorumPct)} % des inscrits ont participé. Les résultats des moins de 18 ans sont aussi publiés séparément.` },
    { key: "evolution", title: "Article 7 · Modification et abrogation", body: "Toute loi adoptée peut être modifiée ou abrogée par une nouvelle proposition, selon la même procédure. Toute proposition peut être reprise par n'importe qui sous forme de variante. L'historique complet de chaque texte reste public." },
    { key: "revision", title: "Article 8 · Révision de la Constitution", body: `Toute disposition de la présente Constitution peut être révisée selon la même procédure. Une révision est adoptée si les voix « pour » représentent plus de ${n_(p.constMajorityPct)} % des suffrages exprimés, et si au moins ${n_(p.constQuorumPct)} % des inscrits ont participé. Une proposition suit les règles en vigueur au jour de son dépôt.` },
    { key: "charte", title: "Article 9 · Charte du débat", body: f.charte },
    { key: "moderation", title: "Article 10 · Modération citoyenne", body: `Tout inscrit peut signaler une proposition, une contribution ou un compte. Dès ${p.modReports} signalement${p.modReports > 1 ? "s" : ""}, une affaire est ouverte et confiée à un jury de ${p.modJury} inscrits tirés au sort, hors l'auteur et les auteurs des signalements. Pendant l'examen, une contribution signalée est masquée. Le jury dispose de ${p.modHours} heures. Chaque juré choisit une mesure, de « ne rien faire » à « exclure définitivement » ; la mesure retenue est la médiane des votes. Si moins de la moitié des jurés a voté, le doute profite à l'auteur. L'auteur peut faire appel une fois devant un jury de ${p.modJury * 2 + 1} inscrits. Chaque décision est inscrite au journal public. Un contenu masqué ne disparaît définitivement que si ${p.modDelVotes} inscrits votent pour sa suppression, son auteur exclu. En cas de contenu manifestement illégal, l'équipe d'administration peut le retirer immédiatement ; cette intervention est aussi inscrite au journal.` },
    { key: "codes", title: "Article 11 · Codes", body: `Les lois et les propositions peuvent être réunies dans des codes portant une appellation commune, comme « Code du travail ». Tout inscrit peut demander la création d'un code, la modification de son nom ou de sa description, ou sa suppression. La demande est soumise au vote des inscrits pendant ${p.codeDays} jour${p.codeDays > 1 ? "s" : ""}. Elle est adoptée si les voix « pour » représentent plus de ${n_(p.majorityPct)} % des suffrages exprimés, avec au moins ${p.codeMinVotes} vote${p.codeMinVotes > 1 ? "s" : ""}. Le porteur d'une proposition choisit son code pendant la phase Projet ; une loi adoptée garde le code de sa proposition. Supprimer un code ne supprime aucun texte.` }
  ];
}

/** Articles modifiés entre deux états, avec leur diff. */
export function constDiffs(a, b) {
  const A = constArticles(a), B = constArticles(b);
  return B.map((art, i) => ({ title: art.title, d: diffView(A[i].body, art.body) })).filter(x => x.d.changed);
}

export function paramChanges(a, b) {
  return PARAMS.filter(p => a.params[p.k] !== b.params[p.k]).map(p => ({ k: p.k, from: a.params[p.k], to: b.params[p.k] }));
}

/** Nettoie une proposition de Constitution reçue de l'extérieur. */
export function sanitizeCst(input) {
  const params = {}, free = {};
  for (const p of PARAMS) {
    const v = parseFloat(String(input?.params?.[p.k] ?? "").replace(",", "."));
    params[p.k] = p.step ? Math.round(v * 10) / 10 : Math.round(v);
  }
  for (const [k] of FREE_KEYS) free[k] = String(input?.free?.[k] ?? "").trim().slice(0, 4000);
  return { params, free };
}

export function validateCst(c) {
  for (const p of PARAMS) {
    const v = c.params[p.k];
    if (!Number.isFinite(v)) return `« ${p.l} » doit être un nombre.`;
    if (v < p.min || v > p.max) return `« ${p.l} » doit être entre ${n_(p.min)} et ${p.max.toLocaleString("fr-FR")}.`;
  }
  if (c.params.projetMin > c.params.projetMax) return "La durée minimum de la phase Projet dépasse le maximum.";
  if (c.params.delibMin > c.params.delibMax) return "La durée minimum de délibération dépasse le maximum.";
  for (const [k, l] of FREE_KEYS) if (!c.free[k]) return `Le texte « ${l} » ne peut pas être vide.`;
  return null;
}

/**
 * Fusion « à la git » : applique sur la version en vigueur seulement ce que la
 * révision a changé par rapport à la version sur laquelle elle a été rédigée.
 */
export function mergedCst(base, target, current) {
  const out = { params: { ...current.params }, free: { ...current.free } };
  for (const { k } of PARAMS) if (target.params[k] !== base.params[k]) out.params[k] = target.params[k];
  for (const [k] of FREE_KEYS) if (target.free[k] !== base.free[k]) out.free[k] = target.free[k];
  return out;
}

/** Inverse : exprime un état complet saisi sur la version en vigueur, relativement à la base. */
export function relativeToBase(edited, base, current) {
  const out = { params: { ...base.params }, free: { ...base.free } };
  for (const { k } of PARAMS) if (edited.params[k] !== current.params[k]) out.params[k] = edited.params[k];
  for (const [k] of FREE_KEYS) if (edited.free[k] !== current.free[k]) out.free[k] = edited.free[k];
  return out;
}
