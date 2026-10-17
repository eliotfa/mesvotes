// Routes de l'API JSON.
import fs from "node:fs";
import path from "node:path";
import { q, tx, S } from "./db.js";
import { config } from "./config.js";
import { fail, readJson, readBody, rateLimit, clientIp, sendJson } from "./http.js";
import {
  hashPassword, verifyPassword, burnTime, createSession, destroySession, currentUser, revokeSessions,
  createToken, consumeToken
} from "./auth.js";
import { sendMail } from "./mail.js";
import {
  now, uid, isMod, isAdmin, journal, cstNow, cstAll, electorate, getProposal, proposalDetail, proposalSummaries,
  lawFull, lawsAll, lastVersion, versionsOf
} from "./model.js";
import { settle, forceAdvance } from "./lifecycle.js";
import { flag, castVote, appeal, moderationOverview, caseDetail, urgentRemove } from "./moderation.js";
import { moderate } from "../public/shared/moderation.js";
import { sanitizeCst, validateCst, constDiffs, relativeToBase, mergedCst } from "../public/shared/constitution.js";
import { paras, normText, parseTags, normQ, THEMES, KINDS, PHASE_INDEX } from "../public/shared/util.js";

/* ---------- validation ---------- */
const str = (v, min, max, label) => {
  const s = String(v ?? "").trim();
  if (s.length < min) fail(400, min <= 1 ? `${label} est obligatoire.` : `${label} doit faire au moins ${min} caractères.`);
  if (s.length > max) fail(400, `${label} ne doit pas dépasser ${max} caractères.`);
  return s;
};
function checkContent(...texts) {
  const r = moderate(texts.join("\n"));
  if (r) { journal(`Contribution retenue par le filtre automatique · motif : ${r.kind}`); fail(422, r.msg, { moderation: r }); }
}
const meView = u => u && {
  id: u.id, pseudo: u.pseudo, email: u.email, minor: !!u.minor, role: u.role, emailVerified: !!u.email_verified,
  suspendedUntil: u.suspended_until > now() ? u.suspended_until : 0,
  duties: q("SELECT COUNT(*) c FROM case_jurors j JOIN cases c ON c.id=j.case_id WHERE j.user_id=? AND c.status='open' AND j.vote IS NULL").get(u.id).c,
  unread: q("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0").get(u.id).c
};

function requireUser(req) { const u = currentUser(req); if (!u) fail(401, "Connecte-toi pour continuer."); return u; }
function requireActive(req) {
  const u = requireUser(req);
  if (config.mailEnabled && !u.email_verified) fail(403, "Confirme d'abord ton adresse e-mail : clique sur le lien reçu (ou renvoie-le depuis « Mon compte »).");
  if (u.suspended_until > now()) fail(403, `Ton compte est suspendu jusqu'au ${new Date(u.suspended_until).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" })} par décision d'un jury citoyen. Tu peux toujours lire et faire appel.`);
  return u;
}
function requireMod(req) { const u = requireUser(req); if (!isMod(u)) fail(403, "Réservé à la modération."); return u; }
function requireAdmin(req) { const u = requireUser(req); if (!isAdmin(u)) fail(403, "Réservé aux administrateurs."); return u; }
function loadForAction(id) { const p = settle(id); if (!p || p.hidden) fail(404, "Proposition introuvable."); return p; }

const PSEUDO_RE = /^[A-Za-z0-9._-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- comptes ---------- */
async function sendVerification(u) {
  const t = createToken(u.id, "verify", 48);
  await sendMail({ to: u.email, subject: "Confirme ton inscription sur mesvotes", text:
    `Bonjour ${u.pseudo},\n\nPour confirmer ton adresse et pouvoir proposer, parrainer et voter, ouvre ce lien :\n${config.baseUrl}/api/auth/verify?t=${t}\n\nLe lien est valable 48 heures. Si tu n'es pas à l'origine de cette inscription, ignore ce message.\n\nmesvotes.fr` });
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), handler });

route("GET", "/api/bootstrap", (req) => {
  const u = currentUser(req);
  const counts = q("SELECT SUM(phase='vote') votes, COUNT(*) total FROM proposals WHERE hidden=0").get();
  return {
    me: meView(u), constitution: cstAll(), electorate: electorate(), demoMode: config.demoMode, mailEnabled: config.mailEnabled,
    stats: { proposals: counts.total || 0, votesOpen: counts.votes || 0, lawsInForce: q("SELECT COUNT(*) c FROM laws WHERE status='vigueur'").get().c }
  };
});

route("POST", "/api/auth/register", async (req, res) => {
  rateLimit("reg:" + clientIp(req, config.trustProxy), 5, 3600e3, "Trop d'inscriptions depuis cette connexion. Réessaie plus tard.");
  const b = await readJson(req);
  const email = str(b.email, 3, 200, "L'e-mail").toLowerCase();
  if (!EMAIL_RE.test(email)) fail(400, "Cette adresse e-mail n'est pas valide.");
  const pseudo = str(b.pseudo, 3, 20, "Le pseudo");
  if (!PSEUDO_RE.test(pseudo)) fail(400, "Pseudo : 3 à 20 caractères, lettres sans accent, chiffres, point, tiret ou tiret bas.");
  const r = moderate(pseudo, { allowCaps: true }); if (r) fail(422, "Ce pseudo n'est pas acceptable. Choisis-en un autre.");
  const password = String(b.password || "");
  if (password.length < 8) fail(400, "Le mot de passe doit faire au moins 8 caractères.");
  if (q("SELECT 1 x FROM users WHERE email=?").get(email)) fail(409, "Un compte existe déjà avec cet e-mail. Connecte-toi.");
  if (q("SELECT 1 x FROM users WHERE pseudo_lc=?").get(pseudo.toLowerCase())) fail(409, "Ce pseudo est déjà pris.");
  const first = !q("SELECT 1 x FROM users WHERE pass_hash IS NOT NULL LIMIT 1").get();
  const role = (config.adminEmail ? email === config.adminEmail : first) ? "admin" : "user";
  const info = q("INSERT INTO users(email,pseudo,pseudo_lc,pass_hash,minor,role,email_verified,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(email, pseudo, pseudo.toLowerCase(), hashPassword(password), b.minor ? 1 : 0, role, config.mailEnabled ? 0 : 1, now());
  const u = q("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
  createSession(res, u.id);
  if (config.mailEnabled) sendVerification(u).catch(() => {});
  return { me: meView(u) };
});

route("POST", "/api/auth/login", async (req, res) => {
  const b = await readJson(req);
  const email = String(b.email || "").trim().toLowerCase();
  rateLimit("login:" + clientIp(req, config.trustProxy), 20, 900e3);
  rateLimit("login:" + email, 8, 900e3);
  const u = q("SELECT * FROM users WHERE email=?").get(email);
  if (!u) { burnTime(b.password); fail(401, "E-mail ou mot de passe incorrect."); }
  if (!verifyPassword(b.password, u.pass_hash)) fail(401, "E-mail ou mot de passe incorrect.");
  if (u.banned) fail(403, "Ce compte a été suspendu par la modération.");
  createSession(res, u.id);
  return { me: meView(u) };
});

route("POST", "/api/auth/logout", (req, res) => { destroySession(req, res); return { ok: true }; });

route("GET", "/api/auth/verify", (req, res, { url }) => {
  const userId = consumeToken(url.searchParams.get("t"), "verify");
  if (userId) q("UPDATE users SET email_verified=1 WHERE id=?").run(userId);
  res.writeHead(302, { Location: userId ? "/#/compte?ok=verifie" : "/#/compte?ok=lien-expire" }); res.end();
  return null;
});

route("POST", "/api/auth/resend", async (req) => {
  const u = requireUser(req);
  if (!config.mailEnabled || u.email_verified) return { ok: true };
  rateLimit("resend:" + u.id, 3, 3600e3);
  await sendVerification(u);
  return { ok: true };
});

route("POST", "/api/auth/forgot", async (req) => {
  if (!config.mailEnabled) fail(400, "La réinitialisation par e-mail n'est pas encore activée. Contacte un administrateur.");
  rateLimit("forgot:" + clientIp(req, config.trustProxy), 5, 3600e3);
  const b = await readJson(req);
  const u = q("SELECT * FROM users WHERE email=?").get(String(b.email || "").trim().toLowerCase());
  if (u && !u.banned) {
    const t = createToken(u.id, "reset", 2);
    sendMail({ to: u.email, subject: "Nouveau mot de passe mesvotes", text: `Bonjour ${u.pseudo},\n\nPour choisir un nouveau mot de passe, ouvre ce lien (valable 2 heures) :\n${config.baseUrl}/#/reinitialiser?t=${t}\n\nSi tu n'as rien demandé, ignore ce message.\n\nmesvotes.fr` }).catch(() => {});
  }
  return { ok: true };
});

route("POST", "/api/auth/reset", async (req, res) => {
  const b = await readJson(req);
  if (String(b.password || "").length < 8) fail(400, "Le mot de passe doit faire au moins 8 caractères.");
  const userId = consumeToken(b.token, "reset");
  if (!userId) fail(400, "Ce lien a expiré. Refais une demande.");
  q("UPDATE users SET pass_hash=?, email_verified=1 WHERE id=?").run(hashPassword(b.password), userId);
  revokeSessions(userId); createSession(res, userId);
  return { ok: true };
});

route("PATCH", "/api/me", async (req) => {
  const u = requireUser(req), b = await readJson(req);
  if (!verifyPassword(b.currentPassword, u.pass_hash)) fail(401, "Mot de passe actuel incorrect.");
  if (String(b.newPassword || "").length < 8) fail(400, "Le nouveau mot de passe doit faire au moins 8 caractères.");
  q("UPDATE users SET pass_hash=? WHERE id=?").run(hashPassword(b.newPassword), u.id);
  return { ok: true };
});

route("DELETE", "/api/me", async (req, res) => {
  const u = requireUser(req), b = await readJson(req);
  if (!verifyPassword(b.password, u.pass_hash)) fail(401, "Mot de passe incorrect.");
  // Les contributions restent (elles font partie de l'historique public), le compte est anonymisé.
  q("UPDATE users SET email=?, pseudo=?, pseudo_lc=?, pass_hash=NULL, banned=1 WHERE id=?").run(`supprime-${u.id}@invalid`, `ancien-membre-${u.id}`, `ancien-membre-${u.id}`, u.id);
  revokeSessions(u.id); destroySession(req, res);
  return { ok: true };
});

/* ---------- propositions ---------- */
route("GET", "/api/proposals", (req, res, { url }) => {
  const u = currentUser(req), P = url.searchParams, f = k => (P.get(k) || "").trim();
  const all = proposalSummaries(u);
  const tagsCount = new Map(), authors = new Set(), phaseCounts = {};
  for (const s of all) { s.tags.forEach(t => tagsCount.set(t, (tagsCount.get(t) || 0) + 1)); authors.add(s.author.pseudo); phaseCounts[s.phase] = (phaseCounts[s.phase] || 0) + 1; }
  const words = normQ(f("q")).split(/\s+/).filter(Boolean);
  const from = f("from") ? Date.parse(f("from") + "T00:00:00") : null, to = f("to") ? Date.parse(f("to") + "T23:59:59") : null;
  let L = all.filter(s => (!f("kind") || s.kind === f("kind")) && (!f("phase") || s.phase === f("phase")) && (!f("theme") || s.themes.includes(f("theme"))) &&
    (!f("tag") || s.tags.includes(f("tag"))) && (!f("author") || s.author.pseudo === f("author")) && (f("only27") !== "1" || s.is2027) &&
    (from === null || s.dates.projet >= from) && (to === null || s.dates.projet <= to) && (f("mine") !== "1" || (u && s._authorId === u.id)) &&
    words.every(w => s._search.includes(w)));
  const ORDER = ["vote", "deliberation", "parrainage", "projet", "fin"];
  const sorters = {
    avance: (a, b) => (ORDER.indexOf(a.phase) - ORDER.indexOf(b.phase)) || (b.dates.projet - a.dates.projet),
    recent: (a, b) => b.dates.projet - a.dates.projet,
    ancien: (a, b) => a.dates.projet - b.dates.projet,
    echeance: (a, b) => ((a.phase === "fin") - (b.phase === "fin")) || (a.phaseEnd - b.phaseEnd),
    contrib: (a, b) => b.notesCount - a.notesCount,
    parrains: (a, b) => b.parrains - a.parrains,
    titre: (a, b) => a.title.localeCompare(b.title, "fr")
  };
  L.sort(sorters[f("sort")] || sorters.avance);
  const total = L.length, offset = Math.max(0, Number(f("offset")) || 0), limit = Math.min(200, Number(f("limit")) || 100);
  L = L.slice(offset, offset + limit).map(({ _search, _authorId, ...s }) => s);
  return {
    items: L, total, phaseCounts,
    facets: { tags: [...tagsCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr")), authors: [...authors].sort((a, b) => a.localeCompare(b, "fr")) }
  };
});

route("GET", "/api/proposals/:id", (req, res, { params }) => {
  settle(params.id);
  const d = proposalDetail(params.id, currentUser(req));
  if (!d) fail(404, "Proposition introuvable.");
  return d;
});

function cleanLinks(list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split("\n")).map(s => String(s).trim()).filter(Boolean);
  if (arr.length > 10) fail(400, "10 liens maximum.");
  return arr.map(u => {
    let url; try { url = new URL(u); } catch { fail(400, `Lien invalide : ${u.slice(0, 80)}`); }
    if (!/^https?:$/.test(url.protocol)) fail(400, `Lien invalide : ${u.slice(0, 80)}`);
    return { label: url.hostname.replace(/^www\./, ""), url: url.href.slice(0, 500) };
  });
}
function cleanThemes(list, kind) {
  const t = (Array.isArray(list) ? list : []).filter(x => THEMES.includes(x) && x !== "Constitution");
  return kind === "const" ? ["Constitution", ...t] : [...new Set(t)];
}

route("POST", "/api/proposals", async (req) => {
  const u = requireActive(req);
  rateLimit("prop:" + u.id, 5, 3600e3, "Tu as déposé beaucoup de propositions en peu de temps. Réessaie dans une heure.");
  const b = await readJson(req);
  const kind = String(b.kind || "loi"); if (!KINDS[kind]) fail(400, "Type de proposition inconnu.");
  const title = str(b.title, 5, 120, "Le titre"), summary = str(b.summary, 10, 280, "Le résumé");
  const text = normText(str(b.text, 10, 20000, kind === "loi" || kind === "modif" ? "Le texte" : "L'exposé des motifs"));
  const tags = parseTags(b.tags), themes = cleanThemes(b.themes, kind), links = cleanLinks(b.links);
  const cur = cstNow(), r = cur.params;
  const projetDays = Math.round(Number(b.projetDays)), delibDays = Math.round(Number(b.delibDays));
  if (!(projetDays >= r.projetMin && projetDays <= r.projetMax)) fail(400, `La phase Projet doit durer entre ${r.projetMin} et ${r.projetMax} jours.`);
  if (!(delibDays >= r.delibMin && delibDays <= r.delibMax)) fail(400, `La délibération doit durer entre ${r.delibMin} et ${r.delibMax} jours.`);
  checkContent(title, summary, text, tags.join(" "));
  const fileIds = (Array.isArray(b.files) ? b.files : []).slice(0, 10).map(String);
  const files = fileIds.map(id => q("SELECT id,name,size FROM uploads WHERE id=? AND user_id=?").get(id, u.id)).filter(Boolean).map(f => ({ id: f.id, name: f.name, size: f.size }));
  let forkOf = null; if (b.forkOf) { const f = getProposal(b.forkOf); if (f && !f.hidden) forkOf = f.id; }
  let target = null, constBase = null, cst = null;
  if (kind === "modif" || kind === "abrog") {
    const law = lawFull(b.lawId);
    if (!law || law.status !== "vigueur") fail(400, "Choisis une loi en vigueur.");
    target = { lawId: law.id, base: law.versions.length };
    if (kind === "modif" && text === normText(law.versions[law.versions.length - 1].text)) fail(400, "Le texte proposé est identique à la loi en vigueur. Modifie-le avant de déposer.");
  }
  if (kind === "const") {
    cst = sanitizeCst(b.cst);
    const err = validateCst(cst); if (err) fail(400, err);
    checkContent(...Object.values(cst.free));
    if (!constDiffs(cur, cst).length) fail(400, "Modifie au moins une règle ou un texte de la Constitution.");
    constBase = { v: cur.n, params: cur.params, free: cur.free };
  }
  const id = uid(10), at = now();
  tx(() => {
    q(`INSERT INTO proposals(id,kind,title,summary,author_id,themes,tags,is2027,phase,dates,projet_days,delib_days,rules,const_v,target_law,target_base,const_base,fork_of,files,links,created_at)
       VALUES (?,?,?,?,?,?,?,?,'projet',?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, kind, title, summary, u.id, S(themes), S(tags), b.is2027 ? 1 : 0, S({ projet: at }), projetDays, delibDays, S(r), cur.n,
        target?.lawId ?? null, target?.base ?? null, constBase ? S(constBase) : null, forkOf, S(files), S(links), at);
    q("INSERT INTO proposal_versions(proposal_id,n,date,note,text,cst) VALUES (?,1,?,?,?,?)").run(id, at, "Version initiale", text, cst ? S(cst) : null);
  });
  return { id };
});

route("POST", "/api/proposals/:id/versions", async (req, res, { params }) => {
  const u = requireActive(req), p = loadForAction(params.id), b = await readJson(req);
  if (p.authorId !== u.id) fail(403, "Seul le porteur peut publier une nouvelle version.");
  if (p.phase !== "projet") fail(409, "Le texte est figé : la phase Projet est terminée.");
  const note = str(b.note, 3, 140, "La description du changement");
  const text = normText(str(b.text, 10, 20000, "Le texte"));
  checkContent(text, note);
  let cst = null;
  if (p.kind === "const") {
    const edited = sanitizeCst(b.cst), err = validateCst(edited); if (err) fail(400, err);
    checkContent(...Object.values(edited.free));
    cst = relativeToBase(edited, p.constBase, cstNow());
  }
  const n = lastVersion(p.id).n + 1;
  q("INSERT INTO proposal_versions(proposal_id,n,date,note,text,cst) VALUES (?,?,?,?,?,?)").run(p.id, n, now(), note, text, cst ? S(cst) : null);
  return { n };
});

route("PATCH", "/api/proposals/:id/meta", async (req, res, { params }) => {
  const u = requireActive(req), p = loadForAction(params.id), b = await readJson(req);
  if (p.authorId !== u.id) fail(403, "Seul le porteur peut modifier les thèmes et les tags.");
  if (p.phase !== "projet") fail(409, "Les thèmes et tags sont figés après la phase Projet.");
  p.tags = parseTags(b.tags); p.themes = cleanThemes(b.themes, p.kind);
  checkContent(p.tags.join(" "));
  q("UPDATE proposals SET themes=?, tags=? WHERE id=?").run(S(p.themes), S(p.tags), p.id);
  return { ok: true };
});

route("POST", "/api/proposals/:id/notes", async (req, res, { params }) => {
  const u = requireActive(req), p = loadForAction(params.id), b = await readJson(req);
  rateLimit("note:" + u.id, 30, 600e3, "Tu publies beaucoup en peu de temps. Fais une pause de quelques minutes.");
  if (p.phase === "fin") fail(409, "Le débat est clos sur cette proposition.");
  const type = ["comment", "amend", "source"].includes(b.type) ? b.type : "comment";
  const text = str(b.text, 2, 3000, "Le message");
  let para = null, base = null, proposed = null, status = null;
  if (type === "amend") {
    if (p.phase !== "projet" || !(p.kind === "loi" || p.kind === "modif")) fail(409, "Les amendements ne sont possibles que pendant la phase Projet d'une loi ou d'une modification.");
    const ps = paras(lastVersion(p.id).text);
    para = Math.round(Number(b.para));
    if (!(para >= 1 && para <= ps.length + 1)) fail(400, "Paragraphe inconnu.");
    base = ps[para - 1] || ""; proposed = str(b.proposed, 2, 4000, "La nouvelle rédaction").replace(/\s*\n\s*/g, " ");
    if (proposed === base) fail(400, "Rien ne change : modifie la rédaction du paragraphe avant de proposer l'amendement.");
    status = "pending";
  }
  checkContent(text, proposed || "");
  const id = uid(12);
  q("INSERT INTO notes(id,proposal_id,type,author_id,date,text,para,base,proposed,status) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, p.id, type, u.id, now(), text, para, base, proposed, status);
  return { id };
});

route("POST", "/api/notes/:id/decision", async (req, res, { params }) => {
  const u = requireActive(req), b = await readJson(req);
  const n = q("SELECT * FROM notes WHERE id=?").get(params.id); if (!n) fail(404, "Contribution introuvable.");
  const p = loadForAction(n.proposal_id);
  if (p.authorId !== u.id) fail(403, "Seul le porteur décide des amendements.");
  if (p.phase !== "projet") fail(409, "La phase Projet est terminée.");
  if (n.type !== "amend" || n.status !== "pending") fail(409, "Cet amendement a déjà été traité.");
  if (b.decision === "accept") {
    tx(() => {
      const lv = lastVersion(p.id), ps = paras(lv.text), i = n.para - 1;
      if (i >= ps.length) ps.push(n.proposed); else ps[i] = n.proposed;
      const para = Math.min(n.para, ps.length);
      q("INSERT INTO proposal_versions(proposal_id,n,date,note,text,cst) VALUES (?,?,?,?,?,NULL)").run(p.id, lv.n + 1, now(), `Intègre l'amendement de @${q("SELECT pseudo FROM users WHERE id=?").get(n.author_id).pseudo} (§${para})`, ps.join("\n\n"));
      q("UPDATE notes SET status='accepted' WHERE id=?").run(n.id);
    });
  } else q("UPDATE notes SET status='refused' WHERE id=?").run(n.id);
  return { ok: true };
});

/* ---------- modération citoyenne ---------- */
route("POST", "/api/reports", async (req) => {
  const u = requireActive(req), b = await readJson(req);
  rateLimit("report:" + u.id, 20, 3600e3, "Tu as fait beaucoup de signalements en peu de temps. Réessaie plus tard.");
  return flag(u, String(b.type || ""), String(b.id || ""), String(b.reason || ""), b.comment);
});
route("GET", "/api/moderation", (req) => moderationOverview(currentUser(req)));
route("GET", "/api/cases/:id", (req, res, { params }) => caseDetail(currentUser(req), params.id));
route("POST", "/api/cases/:id/vote", async (req, res, { params }) => {
  const u = requireActive(req), b = await readJson(req);
  return castVote(u, params.id, String(b.action || ""), b.comment);
});
route("POST", "/api/cases/:id/appeal", (req, res, { params }) => appeal(requireUser(req), params.id));
route("GET", "/api/notifications", (req) => {
  const u = requireUser(req);
  return { items: q("SELECT id,date,text,link,read FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50").all(u.id).map(n => ({ ...n, read: !!n.read })) };
});
route("POST", "/api/notifications/read", (req) => { const u = requireUser(req); q("UPDATE notifications SET read=1 WHERE user_id=?").run(u.id); return { ok: true }; });
route("GET", "/api/users/:pseudo", (req, res, { params }) => {
  const viewer = currentUser(req);
  const u = q("SELECT * FROM users WHERE pseudo_lc=?").get(decodeURIComponent(params.pseudo).toLowerCase());
  if (!u) fail(404, "Ce compte n'existe pas.");
  const closed = !u.pass_hash || !!u.banned;
  return {
    pseudo: u.pseudo, minor: !!u.minor, memberSince: u.created_at, closed, fictional: !u.pass_hash && u.email.endsWith(".invalid"),
    suspended: u.suspended_until > now(), isMe: viewer?.id === u.id,
    myFlag: !!(viewer && q("SELECT 1 x FROM flags WHERE target_type='user' AND target_id=? AND user_id=?").get(String(u.id), viewer.id)),
    notesCount: q("SELECT COUNT(*) c FROM notes WHERE author_id=? AND hidden<2").get(u.id).c,
    proposals: q("SELECT id,title,kind,phase,created_at createdAt FROM proposals WHERE author_id=? AND hidden=0 ORDER BY created_at DESC LIMIT 50").all(u.id),
    warnings: q("SELECT COUNT(*) c FROM sanctions WHERE user_id=? AND revoked=0").get(u.id).c
  };
});

route("POST", "/api/proposals/:id/parrainage", async (req, res, { params }) => {
  const u = requireActive(req), p = loadForAction(params.id), b = await readJson(req);
  if (p.phase !== "parrainage") fail(409, "Cette proposition n'est pas en phase de parrainage.");
  if (b.on === false) q("DELETE FROM parrainages WHERE proposal_id=? AND user_id=?").run(p.id, u.id);
  else q("INSERT OR IGNORE INTO parrainages(proposal_id,user_id,date) VALUES (?,?,?)").run(p.id, u.id, now());
  const after = settle(p.id);
  return { phase: after.phase };
});

route("POST", "/api/proposals/:id/vote", async (req, res, { params }) => {
  const u = requireActive(req), p = loadForAction(params.id), b = await readJson(req);
  if (p.phase !== "vote") fail(409, "Le vote n'est pas ouvert sur cette proposition.");
  if (b.choice === null) q("DELETE FROM votes WHERE proposal_id=? AND user_id=?").run(p.id, u.id);
  else {
    if (!["p", "c", "a"].includes(b.choice)) fail(400, "Choix de vote inconnu.");
    q(`INSERT INTO votes(proposal_id,user_id,choice,minor,date) VALUES (?,?,?,?,?)
       ON CONFLICT(proposal_id,user_id) DO UPDATE SET choice=excluded.choice, date=excluded.date`).run(p.id, u.id, b.choice, u.minor ? 1 : 0, now());
  }
  return { ok: true };
});

route("POST", "/api/proposals/:id/advance", (req, res, { params }) => {
  if (!config.demoMode) fail(403, "Le mode démo n'est pas activé sur ce serveur.");
  requireAdmin(req);
  const p = forceAdvance(params.id); if (!p) fail(404, "Proposition introuvable.");
  return { phase: p.phase, result: p.result };
});

/* ---------- lois, Constitution, journal ---------- */
route("GET", "/api/laws", () => ({ items: lawsAll().map(l => ({ ...l, pending: q("SELECT COUNT(*) c FROM proposals WHERE target_law=? AND phase<>'fin' AND hidden=0").get(l.id).c })) }));
route("GET", "/api/laws/:id", (req, res, { params }) => {
  const l = lawFull(params.id); if (!l) fail(404, "Loi introuvable.");
  const related = q("SELECT id,title,kind,phase FROM proposals WHERE (target_law=? OR law_id=?) AND hidden=0 ORDER BY created_at DESC").all(l.id, l.id);
  return { ...l, related };
});
route("GET", "/api/constitution", () => ({ versions: cstAll() }));
route("GET", "/api/journal", () => ({ items: q("SELECT date,text FROM journal ORDER BY id DESC LIMIT 50").all() }));

/* ---------- fichiers ---------- */
const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  csv: "text/csv", txt: "text/plain", md: "text/plain", odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
const uploadDir = () => path.join(config.dataDir, "uploads");

route("POST", "/api/uploads", async (req) => {
  const u = requireActive(req);
  rateLimit("upload:" + u.id, 30, 3600e3, "Trop de fichiers envoyés en une heure.");
  let name = ""; try { name = decodeURIComponent(String(req.headers["x-file-name"] || "")); } catch { name = ""; }
  name = path.basename(name).replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 120);
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!name || !MIME[ext]) fail(400, "Type de fichier non accepté. Formats possibles : " + Object.keys(MIME).join(", ") + ".");
  const buf = await readBody(req, config.maxUploadBytes);
  if (!buf.length) fail(400, "Fichier vide.");
  const id = uid(20);
  fs.mkdirSync(uploadDir(), { recursive: true });
  fs.writeFileSync(path.join(uploadDir(), id), buf);
  q("INSERT INTO uploads(id,user_id,name,mime,size,date) VALUES (?,?,?,?,?,?)").run(id, u.id, name, MIME[ext], buf.length, now());
  return { id, name, size: buf.length };
});

export function serveUpload(req, res, id) {
  const f = q("SELECT * FROM uploads WHERE id=?").get(String(id));
  const file = f && path.join(uploadDir(), f.id);
  if (!f || !fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Fichier introuvable."); return; }
  const inline = /^(image\/(png|jpeg|webp|gif)|application\/pdf|text\/plain)$/.test(f.mime);
  res.writeHead(200, {
    "Content-Type": f.mime === "text/plain" ? "text/plain; charset=utf-8" : f.mime, "Content-Length": f.size,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    "Cache-Control": "public, max-age=31536000, immutable"
  });
  fs.createReadStream(file).pipe(res);
}

/* ---------- modération et administration ---------- */
route("POST", "/api/mod/urgent", async (req) => {
  const u = requireMod(req), b = await readJson(req);
  urgentRemove(u, String(b.type || ""), String(b.id || ""));
  return { ok: true };
});
route("POST", "/api/mod/proposals/:id", async (req, res, { params }) => {
  requireMod(req); const b = await readJson(req);
  const p = getProposal(params.id); if (!p) fail(404, "Proposition introuvable.");
  const hide = b.action === "hide";
  q("UPDATE proposals SET hidden=? WHERE id=?").run(hide ? 1 : 0, p.id);
  journal(hide ? `Intervention d'urgence de l'administration : proposition « ${p.title.slice(0, 50)} » masquée` : `Proposition « ${p.title.slice(0, 50)} » rétablie par l'administration`);
  return { ok: true };
});
route("GET", "/api/admin/users", (req, res, { url }) => {
  requireAdmin(req);
  const s = "%" + (url.searchParams.get("q") || "").trim().toLowerCase() + "%";
  return { items: q("SELECT id,email,pseudo,minor,role,email_verified emailVerified,banned,suspended_until suspendedUntil,created_at createdAt FROM users WHERE pass_hash IS NOT NULL AND (email LIKE ? OR pseudo_lc LIKE ?) ORDER BY id DESC LIMIT 100").all(s, s) };
});
route("POST", "/api/admin/users/:id", async (req, res, { params }) => {
  const me = requireAdmin(req), b = await readJson(req);
  const u = q("SELECT * FROM users WHERE id=?").get(Number(params.id)); if (!u) fail(404, "Compte introuvable.");
  if (u.id === me.id) fail(400, "Tu ne peux pas modifier ton propre compte ici.");
  if (b.role && ["user", "moderator", "admin"].includes(b.role)) q("UPDATE users SET role=? WHERE id=?").run(b.role, u.id);
  if (typeof b.banned === "boolean") {
    q("UPDATE users SET banned=? WHERE id=?").run(b.banned ? 1 : 0, u.id);
    if (b.banned) { revokeSessions(u.id); journal(`Intervention d'urgence de l'administration : compte @${u.pseudo} suspendu`); }
    else journal(`Compte @${u.pseudo} rétabli par l'administration`);
  }
  return { ok: true };
});

/* ---------- aiguillage ---------- */
export async function handleApi(req, res, url) {
  // Protection CSRF : toute écriture doit venir de notre propre interface.
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.headers["x-mesvotes"] !== "1") fail(403, "Requête refusée.");
    const origin = req.headers.origin;
    if (origin && origin !== config.baseUrl && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) fail(403, "Origine refusée.");
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const out = await r.handler(req, res, { params: m.groups || {}, url });
    if (out !== null && !res.headersSent) sendJson(res, 200, out);
    return;
  }
  fail(404, "Adresse inconnue.");
}

