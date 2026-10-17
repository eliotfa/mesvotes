// Modération citoyenne : signalements → affaire → jury tiré au sort → mesure médiane → appel.
import crypto from "node:crypto";
import { q, tx, J, S } from "./db.js";
import { config } from "./config.js";
import { fail } from "./http.js";
import { revokeSessions } from "./auth.js";
import { sendMail } from "./mail.js";
import { renderMail } from "./mail-template.js";
import { now, uid, cstNow, journal, isAdmin, lastVersion, deletionState } from "./model.js";
import { MOD_ACTIONS, actionsFor, REPORT_REASONS } from "../public/shared/constitution.js";

const HOUR = 3600e3, DAY = 864e5, APPEAL_DAYS = 7;
const SEV = Object.fromEntries(MOD_ACTIONS.map(a => [a.id, a.sev]));
const LABEL = Object.fromEntries(MOD_ACTIONS.map(a => [a.id, a.label]));
const REASON = Object.fromEntries(REPORT_REASONS);
const TYPE = { note: "contribution", proposal: "proposition", user: "compte" };
const fmtDate = ts => new Date(ts).toLocaleString("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const short = id => id.slice(1, 6).toUpperCase();

/* ---------- notifications ---------- */
export function notify(userId, text, link = null, mail = false) {
  if (!userId) return;
  q("INSERT INTO notifications(user_id,date,text,link,read) VALUES (?,?,?,?,0)").run(userId, now(), text, link);
  if (mail && config.mailEnabled) {
    const u = q("SELECT email, pseudo FROM users WHERE id=? AND pass_hash IS NOT NULL").get(userId);
    if (u) sendMail({ to: u.email, subject: "mesvotes : " + text.slice(0, 70), ...renderMail({
      pseudo: u.pseudo, title: "Nouvelle notification", preheader: text, paragraphs: [text],
      button: { label: link ? "Voir le détail" : "Ouvrir mesvotes", url: `${config.baseUrl}/${link || ""}` } }) }).catch(() => {});
  }
}

/* ---------- cibles ---------- */
function targetInfo(type, id) {
  if (type === "note") {
    const n = q(`SELECT n.*, u.pseudo, p.title, p.id pid FROM notes n JOIN users u ON u.id=n.author_id JOIN proposals p ON p.id=n.proposal_id WHERE n.id=?`).get(String(id));
    if (!n) return null;
    return { authorId: n.author_id, gone: n.hidden === 2, label: `contribution sur « ${n.title.slice(0, 60)} »`,
      snapshot: { type, author: n.pseudo, noteType: n.type, text: n.text, base: n.base, proposed: n.proposed, proposalId: n.pid, proposalTitle: n.title, date: n.date } };
  }
  if (type === "proposal") {
    const p = q("SELECT p.*, u.pseudo FROM proposals p JOIN users u ON u.id=p.author_id WHERE p.id=?").get(String(id));
    if (!p) return null;
    return { authorId: p.author_id, gone: p.hidden === 1, label: `proposition « ${p.title.slice(0, 60)} »`,
      snapshot: { type, author: p.pseudo, title: p.title, summary: p.summary, kind: p.kind, text: lastVersion(p.id).text, proposalId: p.id } };
  }
  if (type === "user") {
    const u = q("SELECT * FROM users WHERE pseudo_lc=? OR id=?").get(String(id).toLowerCase(), Number(id) || -1);
    if (!u || !u.pass_hash) return null;
    const recent = q(`SELECT n.text, n.date, p.title, p.id pid FROM notes n JOIN proposals p ON p.id=n.proposal_id WHERE n.author_id=? AND n.hidden<2 ORDER BY n.date DESC LIMIT 10`).all(u.id);
    return { authorId: u.id, gone: !!u.banned, label: `compte @${u.pseudo}`, canonicalId: String(u.id),
      snapshot: { type, author: u.pseudo, memberSince: u.created_at, recent: recent.map(r => ({ text: r.text, date: r.date, proposalTitle: r.title, proposalId: r.pid })) } };
  }
  return null;
}

/* ---------- signalement ---------- */
export function flag(user, type, rawId, reason, comment) {
  if (!TYPE[type]) fail(400, "Type de signalement inconnu.");
  if (!REASON[reason]) fail(400, "Choisis un motif de signalement.");
  comment = String(comment || "").trim().slice(0, 500) || null;
  const info = targetInfo(type, rawId); if (!info) fail(404, "Élément introuvable.");
  const id = info.canonicalId || String(rawId);
  if (info.authorId === user.id) fail(400, type === "user" ? "Tu ne peux pas signaler ton propre compte." : "Tu ne peux pas signaler ta propre contribution.");
  if (info.gone) fail(409, "Cet élément a déjà été retiré.");
  return tx(() => {
    const r = q("INSERT OR IGNORE INTO flags(target_type,target_id,user_id,reason,comment,date,case_id) VALUES (?,?,?,?,?,?,NULL)").run(type, id, user.id, reason, comment, now());
    if (!r.changes) fail(409, "Tu as déjà signalé cet élément.");
    return maybeOpen(type, id);
  });
}

function maybeOpen(type, id) {
  const open = q("SELECT id FROM cases WHERE target_type=? AND target_id=? AND status='open'").get(type, id);
  if (open) { q("UPDATE flags SET case_id=? WHERE target_type=? AND target_id=? AND case_id IS NULL").run(open.id, type, id); return { caseId: open.id, opened: false }; }
  const pending = q("SELECT COUNT(*) c FROM flags WHERE target_type=? AND target_id=? AND case_id IS NULL").get(type, id).c;
  if (pending >= cstNow().params.modReports) return { caseId: openCase(type, id, 1, null, []), opened: true };
  return { caseId: null, opened: false, pending };
}

function openCase(type, id, round, appealOf, extraExclude) {
  const info = targetInfo(type, id), p = cstNow().params, at = now();
  const size = round === 1 ? p.modJury : p.modJury * 2 + 1;
  const caseId = "a" + uid(9);
  q(`INSERT INTO cases(id,target_type,target_id,target_user,round,appeal_of,status,snapshot,opened_at,deadline,jury_size) VALUES (?,?,?,?,?,?,'open',?,?,?,?)`)
    .run(caseId, type, id, info.authorId, round, appealOf, S(info.snapshot), at, at + p.modHours * HOUR, size);
  if (round === 1) q("UPDATE flags SET case_id=? WHERE target_type=? AND target_id=? AND case_id IS NULL").run(caseId, type, id);
  if (type === "note") q("UPDATE notes SET hidden=1 WHERE id=? AND hidden=0").run(id);
  if (type === "proposal") q("UPDATE proposals SET under_review=1 WHERE id=?").run(id);
  const flaggers = q("SELECT user_id FROM flags WHERE case_id=?").all(round === 1 ? caseId : appealOf).map(r => r.user_id);
  const drawn = drawJurors(caseId, size, [info.authorId, ...flaggers, ...extraExclude]);
  const reasons = reasonSummary(round === 1 ? caseId : appealOf);
  notify(info.authorId, round === 1
    ? `Ta ${TYPE[type] === "compte" ? "activité" : TYPE[type]} a été signalée ${flaggers.length} fois. Un jury citoyen de ${drawn} inscrits va l'examiner d'ici le ${fmtDate(at + p.modHours * HOUR)}.`
    : `Ton appel est enregistré. Un nouveau jury de ${drawn} inscrits va réexaminer l'affaire.`, `#/affaire/${caseId}`, true);
  journal(round === 1
    ? `Affaire ${short(caseId)} ouverte : ${TYPE[type]} signalé${type === "user" ? "" : "e"} ${flaggers.length} fois (${reasons[0] ? REASON[reasons[0][0]].toLowerCase() : "motif non précisé"}) · jury de ${drawn} inscrits tirés au sort`
    : `Appel de l'affaire ${short(appealOf)} : nouveau jury de ${drawn} inscrits tirés au sort (affaire ${short(caseId)})`);
  return caseId;
}

function reasonSummary(caseId) {
  return q("SELECT reason, COUNT(*) c FROM flags WHERE case_id=? GROUP BY reason ORDER BY c DESC").all(caseId).map(r => [r.reason, r.c]);
}

/* ---------- tirage au sort ---------- */
/**
 * Tire au sort jusqu'à `count` comptes éligibles, sans charger toute la communauté en mémoire :
 * on lit un rang au hasard (crypto.randomInt) et on écarte les doublons et les exclus.
 */
function drawEligible(caseId, count, exclude) {
  const ex = new Set(exclude.filter(Boolean).map(Number));
  q("SELECT user_id FROM case_jurors WHERE case_id=?").all(caseId).forEach(r => ex.add(r.user_id));
  const where = `pass_hash IS NOT NULL AND banned=0 AND suspended_until<? ${config.mailEnabled ? "AND email_verified=1" : ""}`;
  const total = q(`SELECT COUNT(*) c FROM users WHERE ${where}`).get(now()).c;
  const picked = [];
  // Le rejet est borné : au pire on tire moins de jurés que demandé, jamais une boucle infinie.
  for (let tries = 0; total > 0 && picked.length < count && tries < count * 50; tries++) {
    const row = q(`SELECT id FROM users WHERE ${where} LIMIT 1 OFFSET ?`).get(now(), crypto.randomInt(total));
    if (row && !ex.has(row.id) && !picked.includes(row.id)) picked.push(row.id);
  }
  return picked;
}
function drawJurors(caseId, count, exclude) {
  let picked = drawEligible(caseId, count, exclude);
  const already = q("SELECT COUNT(*) c FROM case_jurors WHERE case_id=?").get(caseId).c;
  // Communauté trop petite : les administrateurs complètent le jury (jamais l'auteur ni les signaleurs).
  if (already + picked.length < 3) {
    const ex = new Set([...exclude.map(Number), ...picked]);
    q("SELECT id FROM users WHERE role='admin' AND banned=0 AND pass_hash IS NOT NULL").all().forEach(r => { if (!ex.has(r.id) && !q("SELECT 1 x FROM case_jurors WHERE case_id=? AND user_id=?").get(caseId, r.id)) picked.push(r.id); });
  }
  const c = q("SELECT deadline FROM cases WHERE id=?").get(caseId);
  for (const uidJ of picked) {
    q("INSERT OR IGNORE INTO case_jurors(case_id,user_id,drawn_at) VALUES (?,?,?)").run(caseId, uidJ, now());
    notify(uidJ, `Tu as été tiré(e) au sort pour juger une affaire de modération. Ton avis compte : tu as jusqu'au ${fmtDate(c.deadline)}.`, `#/affaire/${caseId}`, true);
  }
  return already + picked.length;
}

/* ---------- vote du jury ---------- */
export function castVote(user, caseId, action, comment) {
  return tx(() => {
    const c = q("SELECT * FROM cases WHERE id=?").get(String(caseId)); if (!c) fail(404, "Affaire introuvable.");
    if (c.status !== "open") fail(409, "Cette affaire est close.");
    const j = q("SELECT * FROM case_jurors WHERE case_id=? AND user_id=?").get(c.id, user.id);
    if (!j) fail(403, "Seuls les jurés tirés au sort votent sur cette affaire.");
    if (!actionsFor(c.target_type).some(a => a.id === action)) fail(400, "Mesure inconnue.");
    q("UPDATE case_jurors SET vote=?, comment=?, voted_at=? WHERE case_id=? AND user_id=?").run(action, String(comment || "").trim().slice(0, 500) || null, now(), c.id, user.id);
    const left = q("SELECT COUNT(*) c FROM case_jurors WHERE case_id=? AND vote IS NULL").get(c.id).c;
    if (!left) closeCase(c.id, now());
    return { closed: !left };
  });
}

/** Médiane « basse » : la mesure la plus sévère qu'au moins la moitié des jurés juge justifiée. */
export function median(votes) {
  const s = votes.slice().sort((a, b) => SEV[a] - SEV[b]);
  return s[Math.floor((s.length - 1) / 2)];
}

function closeCase(caseId, at) {
  const c = q("SELECT * FROM cases WHERE id=?").get(caseId);
  if (!c || c.status !== "open") return;
  const jurors = q("SELECT * FROM case_jurors WHERE case_id=?").all(c.id);
  const votes = jurors.filter(j => j.vote).map(j => j.vote);
  const quorum = Math.max(1, Math.ceil(jurors.length / 2));
  if (votes.length < quorum && !c.extended && at >= c.deadline) {
    // Une seule prolongation : on tire au sort des remplaçants pour les absents.
    const p = cstNow().params, flaggers = q("SELECT user_id FROM flags WHERE case_id=?").all(c.appeal_of || c.id).map(r => r.user_id);
    q("UPDATE cases SET extended=1, deadline=? WHERE id=?").run(at + p.modHours * HOUR, c.id);
    const added = drawJurors(c.id, quorum - votes.length, [c.target_user, ...flaggers]) - jurors.length;
    journal(`Affaire ${short(c.id)} : quorum non atteint, ${added} juré${added > 1 ? "s" : ""} supplémentaire${added > 1 ? "s" : ""} tiré${added > 1 ? "s" : ""} au sort`);
    return;
  }
  const tally = Object.fromEntries(actionsFor(c.target_type).map(a => [a.id, votes.filter(v => v === a.id).length]));
  let decision, note;
  if (votes.length < quorum) { decision = "keep"; note = "Quorum non atteint : le doute profite à l'auteur."; }
  else decision = median(votes);
  applyDecision(c, decision);
  q("UPDATE cases SET status='closed', closed_at=?, decision=?, tally=?, note=? WHERE id=?").run(at, decision, S(tally), note || null, c.id);
  const label = actionsFor(c.target_type).find(a => a.id === decision).label;
  notify(c.target_user, SEV[decision] > 0
    ? `Décision du jury citoyen : « ${label} ».${c.round === 1 ? ` Tu peux faire appel pendant ${APPEAL_DAYS} jours.` : " Cette décision d'appel est définitive."}`
    : "Le jury citoyen a examiné le signalement : aucune mesure n'est prise.", `#/affaire/${c.id}`, true);
  jurors.forEach(j => notify(j.user_id, `Affaire close : le jury a retenu « ${label} » (${votes.length} votes sur ${jurors.length}). Merci pour ta participation.`, `#/affaire/${c.id}`));
  journal(`Affaire ${short(c.id)} ${c.round === 2 ? "(appel) " : ""}close : « ${label} » · ${votes.length} jurés sur ${jurors.length} ont voté${note ? " · " + note : ""}`);
}

function recomputeUser(userId) {
  const u = q("SELECT pass_hash FROM users WHERE id=?").get(userId);
  if (!u || !u.pass_hash) return; // compte supprimé : rien à recalculer
  const until = q("SELECT MAX(until) m FROM sanctions WHERE user_id=? AND kind='suspend' AND revoked=0").get(userId).m || 0;
  const ban = !!q("SELECT 1 x FROM sanctions WHERE user_id=? AND kind='ban' AND revoked=0").get(userId);
  q("UPDATE users SET suspended_until=?, banned=? WHERE id=?").run(until, ban ? 1 : 0, userId);
  if (ban) revokeSessions(userId);
}

function applyDecision(c, decision) {
  if (c.appeal_of) {
    // L'appel remplace la première décision : on annule ses effets avant d'appliquer la nouvelle.
    q("UPDATE sanctions SET revoked=1 WHERE case_id=?").run(c.appeal_of);
    recomputeUser(c.target_user);
  }
  const sev = SEV[decision], at = now();
  if (c.target_type === "note") q("UPDATE notes SET hidden=? WHERE id=?").run(sev >= 1 ? 2 : 0, c.target_id);
  if (c.target_type === "proposal") q("UPDATE proposals SET hidden=?, under_review=0 WHERE id=?").run(sev >= 1 ? 1 : 0, c.target_id);
  if (sev === 0) clearDeletionVotes(c.target_type, c.target_id);
  const kind = { warn: "warn", suspend7: "suspend", suspend30: "suspend", ban: "ban" }[decision];
  if (kind) {
    const until = decision === "suspend7" ? at + 7 * DAY : decision === "suspend30" ? at + 30 * DAY : null;
    q("INSERT INTO sanctions(user_id,case_id,kind,until,date) VALUES (?,?,?,?,?)").run(c.target_user, c.id, kind, until, at);
    recomputeUser(c.target_user);
  }
}

/* ---------- appel ---------- */
export function appeal(user, caseId) {
  return tx(() => {
    const c = q("SELECT * FROM cases WHERE id=?").get(String(caseId)); if (!c) fail(404, "Affaire introuvable.");
    if (c.target_user !== user.id) fail(403, "Seule la personne concernée peut faire appel.");
    if (c.status !== "closed" || c.round !== 1) fail(409, "Cette décision ne peut pas faire l'objet d'un appel.");
    if (SEV[c.decision] === 0) fail(409, "Aucune mesure n'a été prise : il n'y a rien à contester.");
    if (c.appealed) fail(409, "Tu as déjà fait appel de cette décision.");
    if (now() - c.closed_at > APPEAL_DAYS * DAY) fail(409, `Le délai d'appel de ${APPEAL_DAYS} jours est dépassé.`);
    q("UPDATE cases SET appealed=1 WHERE id=?").run(c.id);
    const firstJury = q("SELECT user_id FROM case_jurors WHERE case_id=?").all(c.id).map(r => r.user_id);
    return { caseId: openCase(c.target_type, c.target_id, 2, c.id, firstJury) };
  });
}

/* ---------- horloge ---------- */
export function tickModeration(at = now()) {
  let n = 0;
  for (const c of q("SELECT id FROM cases WHERE status='open' AND deadline<=?").all(at)) { tx(() => closeCase(c.id, at)); n++; }
  return n;
}

/* ---------- intervention d'urgence (administration) ---------- */
export function urgentRemove(admin, type, id) {
  const info = targetInfo(type, id); if (!info) fail(404, "Élément introuvable.");
  if (type === "note") q("UPDATE notes SET hidden=2 WHERE id=?").run(id);
  else if (type === "proposal") q("UPDATE proposals SET hidden=1 WHERE id=?").run(id);
  else fail(400, "Un compte se juge par un jury ; seule la suspension par l'administration est possible depuis la page Admin.");
  journal(`Intervention d'urgence de l'administration : ${info.label.replace(/«.*»/, "").trim()} retirée (contenu manifestement illégal)`);
  notify(info.authorId, `L'administration a retiré une de tes ${TYPE[type]}s pour contenu manifestement illégal.`, null, true);
}

/* ---------- suppression par vote (contenu masqué) ---------- */
// Masquer peut se faire seul (intervention d'urgence, réversible). Supprimer définitivement, jamais :
// il faut qu'assez d'inscrits votent pour cela, et seulement sur un contenu déjà masqué.
const DELETABLE = ["note", "proposal"];
const underExamen = (type, id) => !!q("SELECT 1 x FROM cases WHERE target_type=? AND target_id=? AND status='open'").get(type, id);

export function voteDeletion(user, type, rawId, on) {
  if (!DELETABLE.includes(type)) fail(400, "Type de contenu inconnu.");
  const id = String(rawId);
  return tx(() => {
    const t = type === "note"
      ? q("SELECT author_id, hidden FROM notes WHERE id=?").get(id)
      : q("SELECT author_id, hidden, law_id FROM proposals WHERE id=?").get(id);
    if (!t) fail(404, "Élément introuvable.");
    if (!(t.hidden > 0)) fail(409, "Ce contenu n'est pas masqué : seul un contenu masqué peut être supprimé par un vote.");
    if (t.author_id === user.id) fail(400, "Tu ne peux pas voter sur ton propre contenu.");
    if (t.law_id) fail(409, "Une proposition adoptée fait partie du recueil des lois : elle ne peut pas être supprimée.");
    if (underExamen(type, id)) fail(409, "Ce contenu est en cours d'examen par un jury.");
    if (on) q("INSERT OR IGNORE INTO deletion_votes(target_type,target_id,user_id,date) VALUES (?,?,?,?)").run(type, id, user.id, now());
    else q("DELETE FROM deletion_votes WHERE target_type=? AND target_id=? AND user_id=?").run(type, id, user.id);
    const state = deletionState(user, type, id);
    if (on && state.votes >= state.threshold) { purge(type, id, state.votes); return { deleted: true }; }
    return { deleted: false, ...state };
  });
}

function purge(type, id, votes) {
  const info = targetInfo(type, id);
  if (type === "note") q("DELETE FROM notes WHERE id=?").run(id);
  else {
    q("UPDATE proposals SET fork_of=NULL WHERE fork_of=?").run(id);
    q("DELETE FROM proposals WHERE id=?").run(id);
  }
  clearDeletionVotes(type, id);
  journal(`Contenu supprimé définitivement par un vote de ${votes} inscrits : ${info.label}`);
  notify(info.authorId, `Ta ${TYPE[type]} a été supprimée définitivement par un vote de ${votes} inscrits.`, null, true);
}

/** Les votes ne valent que pour un contenu masqué : on les efface dès qu'il est rétabli. */
export function clearDeletionVotes(type, id) {
  q("DELETE FROM deletion_votes WHERE target_type=? AND target_id=?").run(type, String(id));
}

/** Contenus masqués, hors examen en cours, en attente d'un vote de suppression. Sans texte ni auteur. */
function maskedList(viewer) {
  const notes = q(`SELECT n.id, n.author_id, n.date, n.hidden, p.title FROM notes n JOIN proposals p ON p.id=n.proposal_id
    WHERE n.hidden>0 ORDER BY n.date DESC LIMIT 50`).all()
    .filter(n => !underExamen("note", n.id))
    .map(n => ({ type: "note", id: n.id, label: `contribution sur « ${n.title.slice(0, 60)} »`, date: n.date, removed: n.hidden === 2, author: n.author_id }));
  const proposals = q("SELECT id, author_id, created_at date FROM proposals WHERE hidden=1 AND law_id IS NULL ORDER BY created_at DESC LIMIT 50").all()
    .filter(p => !underExamen("proposal", p.id))
    .map(p => ({ type: "proposal", id: p.id, label: "proposition masquée", date: p.date, author: p.author_id }));
  return [...notes, ...proposals].sort((a, b) => b.date - a.date).slice(0, 50)
    .map(({ author, ...x }) => ({ ...x, own: viewer?.id === author, ...deletionState(viewer, x.type, x.id) }));
}

/* ---------- lecture ---------- */
const publicCase = c => ({
  id: c.id, short: short(c.id), targetType: c.target_type, round: c.round, appealOf: c.appeal_of, status: c.status,
  openedAt: c.opened_at, deadline: c.deadline, closedAt: c.closed_at, decision: c.decision, tally: J(c.tally), note: c.note,
  jurySize: q("SELECT COUNT(*) c FROM case_jurors WHERE case_id=?").get(c.id).c,
  votes: q("SELECT COUNT(*) c FROM case_jurors WHERE case_id=? AND vote IS NOT NULL").get(c.id).c,
  reasons: reasonSummary(c.appeal_of || c.id)
});

export function moderationOverview(viewer) {
  const closed = q("SELECT * FROM cases WHERE status='closed' ORDER BY closed_at DESC LIMIT 50").all().map(publicCase);
  const openCount = q("SELECT COUNT(*) c FROM cases WHERE status='open'").get().c;
  const out = { closed, openCount, rules: cstNow().params, masked: maskedList(viewer) };
  if (viewer) {
    out.duties = q(`SELECT c.* FROM case_jurors j JOIN cases c ON c.id=j.case_id WHERE j.user_id=? AND c.status='open' ORDER BY c.deadline`).all(viewer.id)
      .map(c => ({ ...publicCase(c), myVote: q("SELECT vote FROM case_jurors WHERE case_id=? AND user_id=?").get(c.id, viewer.id).vote }));
    out.mine = q("SELECT * FROM cases WHERE target_user=? ORDER BY opened_at DESC LIMIT 20").all(viewer.id).map(publicCase);
  }
  if (isAdmin(viewer) || viewer?.role === "moderator") out.open = q("SELECT * FROM cases WHERE status='open' ORDER BY deadline").all().map(c => ({ ...publicCase(c), snapshot: J(c.snapshot), targetId: c.target_id }));
  return out;
}

export function caseDetail(viewer, caseId) {
  const c = q("SELECT * FROM cases WHERE id=?").get(String(caseId)); if (!c) fail(404, "Affaire introuvable.");
  const juror = viewer && q("SELECT * FROM case_jurors WHERE case_id=? AND user_id=?").get(c.id, viewer.id);
  const isTarget = viewer && c.target_user === viewer.id;
  const staff = isAdmin(viewer) || viewer?.role === "moderator";
  const base = { ...publicCase(c), actions: actionsFor(c.target_type), isJuror: !!juror, isTarget: !!isTarget };
  if (!juror && !isTarget && !staff) {
    if (c.status === "open") fail(403, "Cette affaire est en cours d'examen. Seuls les jurés tirés au sort y ont accès.");
    return base;
  }
  base.snapshot = J(c.snapshot);
  if (juror || staff) base.comments = q("SELECT reason, comment FROM flags WHERE case_id=? AND comment IS NOT NULL").all(c.appeal_of || c.id);
  if (juror) base.myVote = juror.vote, base.myComment = juror.comment;
  if (c.status === "closed" && (juror || staff)) base.juryComments = q("SELECT vote, comment FROM case_jurors WHERE case_id=? AND comment IS NOT NULL").all(c.id);
  if (c.appeal_of) { const first = q("SELECT decision, tally FROM cases WHERE id=?").get(c.appeal_of); base.firstDecision = first.decision; base.firstTally = J(first.tally); }
  if (isTarget) base.canAppeal = c.status === "closed" && c.round === 1 && SEV[c.decision] > 0 && !c.appealed && now() - c.closed_at <= APPEAL_DAYS * DAY;
  if (isTarget) base.appealCase = q("SELECT id FROM cases WHERE appeal_of=?").get(c.id)?.id || null;
  return base;
}
