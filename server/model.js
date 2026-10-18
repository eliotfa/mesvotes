// Accès aux données et mise en forme des objets renvoyés par l'API.
import crypto from "node:crypto";
import { q, J, S } from "./db.js";
import { config } from "./config.js";
import { DEFAULT_FREE, mergedCst, paramChanges, normalizeCst } from "../public/shared/constitution.js";
import { DAY, normQ } from "../public/shared/util.js";

/** Horloge (décalable dans les tests). */
export const clock = { offset: 0 };
export const now = () => Date.now() + clock.offset;

export const uid = (n = 10) => {
  const a = "abcdefghijkmnpqrstuvwxyz23456789", b = crypto.randomBytes(n);
  return Array.from(b, x => a[x % a.length]).join("");
};

export const isMod = u => !!u && (u.role === "moderator" || u.role === "admin");
export const isAdmin = u => !!u && u.role === "admin";

export function journal(text) { q("INSERT INTO journal(date,text) VALUES (?,?)").run(now(), text); }

/* ---------- Constitution ---------- */
const cstRow = r => r && normalizeCst({ n: r.n, date: r.date, params: J(r.params), free: J(r.free), note: r.note, via: r.via });
export function ensureConstitution() {
  if (!q("SELECT n FROM constitution LIMIT 1").get())
    q("INSERT INTO constitution(n,date,params,free,note,via) VALUES (1,?,?,?,?,NULL)").run(now(), S(config.initialParams), S(DEFAULT_FREE), "Constitution fondatrice");
}
export const cstNow = () => cstRow(q("SELECT * FROM constitution ORDER BY n DESC LIMIT 1").get());
export const cstAll = () => q("SELECT * FROM constitution ORDER BY n").all().map(cstRow);

/* ---------- règles ---------- */
export function electorate() {
  const sql = config.mailEnabled ? "SELECT COUNT(*) c FROM users WHERE banned=0 AND email_verified=1" : "SELECT COUNT(*) c FROM users WHERE banned=0 AND pass_hash IS NOT NULL";
  const real = q(sql).get().c;
  // En mode démo, les comptes fictifs des exemples comptent aussi dans le corps électoral.
  const demo = config.seedDemo ? q("SELECT COUNT(*) c FROM users WHERE pass_hash IS NULL AND banned=0").get().c : 0;
  return Math.max(1, real + demo);
}
export const threshold = (p, el = electorate()) => Math.max(p.rules.parrainageMin, Math.ceil(el * p.rules.parrainagePct / 100));
export function phaseEnd(p) {
  const d = p.dates, r = p.rules;
  if (p.phase === "projet") return d.projet + p.projetDays * DAY;
  if (p.phase === "parrainage") return d.parrainage + r.parrainageDays * DAY;
  if (p.phase === "deliberation") return d.deliberation + p.delibDays * DAY;
  if (p.phase === "vote") return d.vote + r.voteDays * DAY;
  return d.fin;
}
export const needMaj = p => p.kind === "const" ? p.rules.constMajorityPct : p.rules.majorityPct;
export const needQuo = p => p.kind === "const" ? p.rules.constQuorumPct : p.rules.quorumPct;

/* ---------- propositions ---------- */
export function rowToProposal(r) {
  if (!r) return null;
  return {
    id: r.id, kind: r.kind, title: r.title, summary: r.summary, authorId: r.author_id,
    themes: J(r.themes) || [], tags: J(r.tags) || [], is2027: !!r.is2027, phase: r.phase, dates: J(r.dates),
    projetDays: r.projet_days, delibDays: r.delib_days, rules: J(r.rules), constV: r.const_v,
    target: r.target_law ? { lawId: r.target_law, base: r.target_base } : null, constBase: normalizeCst(J(r.const_base)), underReview: !!r.under_review,
    forkOf: r.fork_of, lawId: r.law_id, files: J(r.files) || [], links: J(r.links) || [], result: J(r.result),
    hidden: !!r.hidden, createdAt: r.created_at
  };
}
export const getProposal = id => rowToProposal(q("SELECT * FROM proposals WHERE id=?").get(String(id)));
export function saveProposalState(p) {
  q("UPDATE proposals SET phase=?, dates=?, result=?, law_id=?, themes=?, tags=? WHERE id=?")
    .run(p.phase, S(p.dates), p.result ? S(p.result) : null, p.lawId || null, S(p.themes), S(p.tags), p.id);
}
export const versionsOf = id => q("SELECT * FROM proposal_versions WHERE proposal_id=? ORDER BY n").all(id)
  .map(v => ({ n: v.n, date: v.date, note: v.note, text: v.text, cst: normalizeCst(J(v.cst)) }));
export const lastVersion = id => {
  const v = q("SELECT * FROM proposal_versions WHERE proposal_id=? ORDER BY n DESC LIMIT 1").get(id);
  return v && { n: v.n, date: v.date, note: v.note, text: v.text, cst: normalizeCst(J(v.cst)) };
};
const author = id => { const u = q("SELECT pseudo, minor FROM users WHERE id=?").get(id); return u ? { pseudo: u.pseudo, minor: !!u.minor } : { pseudo: "inconnu", minor: false }; };

/* ---------- lois ---------- */
export function lawFull(id) {
  const l = q("SELECT * FROM laws WHERE id=?").get(String(id));
  if (!l) return null;
  return {
    id: l.id, title: l.title, themes: J(l.themes) || [], tags: J(l.tags) || [], status: l.status, createdAt: l.created_at,
    versions: q("SELECT * FROM law_versions WHERE law_id=? ORDER BY n").all(l.id).map(v => ({ n: v.n, date: v.date, text: v.text, note: v.note, via: v.via, abrog: !!v.abrog }))
  };
}
export const lawsAll = () => q("SELECT id FROM laws").all().map(r => lawFull(r.id));

/* ---------- sérialisation ---------- */
function participation(id) { return q("SELECT COUNT(*) c FROM vote_participations WHERE proposal_id=?").get(id).c; }

/** Votes pour supprimer définitivement un contenu masqué. */
export function deletionState(viewer, type, id) {
  const votes = q("SELECT COUNT(*) c FROM deletion_votes WHERE target_type=? AND target_id=?").get(type, String(id)).c;
  const mine = !!viewer && !!q("SELECT 1 x FROM deletion_votes WHERE target_type=? AND target_id=? AND user_id=?").get(type, String(id), viewer.id);
  return { votes, threshold: cstNow().params.modDelVotes, mine };
}

export function proposalDetail(id, viewer) {
  const p = getProposal(id);
  if (!p) return null;
  const vid = viewer?.id ?? -1;
  // Masquée : le public ne voit ni le texte ni le titre, mais peut voter pour sa suppression définitive.
  if (p.hidden && !isMod(viewer)) return { id: p.id, kind: p.kind, masked: true, isAuthor: p.authorId === vid, deletion: deletionState(viewer, "proposal", p.id) };
  const el = electorate();
  const versions = versionsOf(p.id);
  const notes = q(`SELECT n.*, u.pseudo, u.minor AS uminor,
                     (SELECT 1 FROM flags f WHERE f.target_type='note' AND f.target_id=n.id AND f.user_id=?) AS mine,
                     (SELECT COUNT(*) FROM flags f WHERE f.target_type='note' AND f.target_id=n.id AND f.case_id IS NULL) AS pending,
                     (SELECT id FROM cases c WHERE c.target_type='note' AND c.target_id=n.id AND c.status='open') AS open_case
                   FROM notes n JOIN users u ON u.id=n.author_id WHERE n.proposal_id=? ORDER BY n.date`).all(vid, p.id).map(n => {
    const base = { id: n.id, type: n.type, author: n.pseudo, minor: !!n.uminor, date: n.date, para: n.para, status: n.status, reports: n.pending, underReview: !!n.open_case, mine: n.author_id === vid, myReport: !!n.mine,
      deletion: n.hidden ? deletionState(viewer, "note", n.id) : null };
    if (n.hidden === 2) return { ...base, removed: true };
    if (n.hidden === 1 && !(isMod(viewer) || n.author_id === vid)) return { ...base, masked: true };
    return { ...base, masked: n.hidden === 1, text: n.text, base: n.base, proposed: n.proposed };
  });
  const out = {
    ...p, authorId: undefined, author: author(p.authorId), isAuthor: p.authorId === vid,
    myFlag: !!q("SELECT 1 x FROM flags WHERE target_type='proposal' AND target_id=? AND user_id=?").get(p.id, vid),
    versions, notes,
    parrains: q("SELECT COUNT(*) c FROM parrainages WHERE proposal_id=?").get(p.id).c,
    myParrain: !!q("SELECT 1 x FROM parrainages WHERE proposal_id=? AND user_id=?").get(p.id, vid),
    participation: participation(p.id),
    // On sait si l'inscrit a voté, jamais ce qu'il a voté : l'urne ne connaît pas les comptes.
    voted: !!q("SELECT 1 x FROM vote_participations WHERE proposal_id=? AND user_id=?").get(p.id, vid),
    threshold: threshold(p, el), phaseEnd: phaseEnd(p), electorate: el,
    law: p.target ? lawFull(p.target.lawId) : null,
    fork: p.forkOf ? (q("SELECT id,title FROM proposals WHERE id=?").get(p.forkOf) || null) : null,
    variants: q("SELECT id,title,phase,author_id FROM proposals WHERE fork_of=? AND hidden=0").all(p.id).map(v => ({ id: v.id, title: v.title, phase: v.phase, author: author(v.author_id) }))
  };
  if (p.kind === "const" && p.phase !== "fin") out.merged = mergedCst(p.constBase, versions[versions.length - 1].cst, cstNow());
  return out;
}

/** Résumés pour les listes, avec le texte de recherche. */
export function proposalSummaries(viewer) {
  const el = electorate();
  const count = sql => Object.fromEntries(q(sql).all().map(r => [r.id, r.c]));
  const nVersions = count("SELECT proposal_id id, COUNT(*) c FROM proposal_versions GROUP BY proposal_id");
  const nNotes = count("SELECT proposal_id id, COUNT(*) c FROM notes WHERE hidden<2 GROUP BY proposal_id");
  const nParr = count("SELECT proposal_id id, COUNT(*) c FROM parrainages GROUP BY proposal_id");
  const nVotes = count("SELECT proposal_id id, COUNT(*) c FROM vote_participations GROUP BY proposal_id");
  const last = Object.fromEntries(q(`SELECT pv.proposal_id id, pv.text, pv.cst FROM proposal_versions pv
     JOIN (SELECT proposal_id, MAX(n) m FROM proposal_versions GROUP BY proposal_id) x ON x.proposal_id=pv.proposal_id AND pv.n=x.m`).all().map(r => [r.id, r]));
  const laws = Object.fromEntries(q("SELECT id, title FROM laws").all().map(l => [l.id, l.title]));
  // Auteurs joints à la requête : on ne charge pas toute la table des comptes à chaque liste.
  const rows = q(`SELECT p.*, u.pseudo AS a_pseudo, u.minor AS a_minor FROM proposals p
     LEFT JOIN users u ON u.id=p.author_id ${isMod(viewer) ? "" : "WHERE p.hidden=0"}`).all();
  return rows.map(r => {
    const p = rowToProposal(r), lv = last[p.id] || {};
    const a = r.a_pseudo ? { pseudo: r.a_pseudo, minor: !!r.a_minor } : { pseudo: "inconnu", minor: false };
    const lawTitle = p.target ? laws[p.target.lawId] || "" : "";
    const s = {
      id: p.id, kind: p.kind, title: p.title, summary: p.summary, author: a, themes: p.themes, tags: p.tags, is2027: p.is2027,
      phase: p.phase, dates: p.dates, hidden: p.hidden, versionsCount: nVersions[p.id] || 0, notesCount: nNotes[p.id] || 0,
      attCount: p.files.length + p.links.length, parrains: nParr[p.id] || 0, threshold: threshold(p, el), phaseEnd: phaseEnd(p),
      participation: nVotes[p.id] || 0, targetTitle: lawTitle, forkOf: p.forkOf,
      result: p.result ? { outcome: p.result.outcome, pourPct: p.result.pourPct } : null
    };
    if (p.kind === "const" && p.constBase && lv.cst) s.constChanges = paramChanges(p.constBase, normalizeCst(J(lv.cst)));
    s.underReview = p.underReview;
    s._search = normQ([p.title, p.summary, lv.text || "", a.pseudo, ...p.tags, ...p.themes, lawTitle].join(" "));
    s._authorId = p.authorId;
    return s;
  });
}
