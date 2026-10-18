// Codes : des appellations (« Code du travail »…) qui réunissent des lois et des propositions.
// Créer, modifier ou supprimer un code se décide par un vote des inscrits (Constitution, art. 11).
import { db, q, tx, S, J } from "./db.js";
import { fail } from "./http.js";
import { now, uid, journal, cstNow } from "./model.js";
import { notify } from "./moderation.js";
import { normQ, DAY } from "../public/shared/util.js";
import { newReceipt, receiptHash, dayOf } from "./ballot.js";

/* ---------- schéma ---------- */
// Tables créées ici, de façon idempotente, pour ne pas dépendre de l'ordre des migrations de db.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS codes(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'actif',
    created_at INTEGER NOT NULL,
    via TEXT
  );
  CREATE TABLE IF NOT EXISTS code_requests(
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    code_id TEXT,
    name TEXT,
    description TEXT,
    reason TEXT NOT NULL,
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    rules TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    result TEXT
  );
  CREATE INDEX IF NOT EXISTS code_requests_status ON code_requests(status, ends_at);
  -- Secret du vote, comme pour les propositions : qui a voté (et quel jour) d'un côté, quoi de l'autre.
  CREATE TABLE IF NOT EXISTS code_participations(
    request_id TEXT NOT NULL REFERENCES code_requests(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day INTEGER NOT NULL,
    PRIMARY KEY(request_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS code_ballots(
    request_id TEXT NOT NULL REFERENCES code_requests(id) ON DELETE CASCADE,
    ballot_id TEXT NOT NULL,
    choice TEXT NOT NULL,
    PRIMARY KEY(request_id, ballot_id)
  ) WITHOUT ROWID;
`);
// Ancienne table qui reliait chaque choix à un compte : reprise dans un ordre aléatoire, puis effacée du fichier.
if (db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='code_votes'").get()) {
  db.exec(`BEGIN;
    INSERT OR IGNORE INTO code_participations(request_id,user_id,day) SELECT request_id, user_id, (date / 86400000) * 86400000 FROM code_votes;
    INSERT INTO code_ballots(request_id,ballot_id,choice) SELECT request_id, lower(hex(randomblob(32))), choice FROM code_votes ORDER BY random();
    DROP TABLE code_votes;
    COMMIT;`);
  db.exec("VACUUM");
}
for (const table of ["proposals", "laws"])
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === "code_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN code_id TEXT`);

const ACTIONS = { create: "créer", modify: "modifier", delete: "supprimer" };

/* ---------- lecture ---------- */
const codeRow = r => r && { id: r.id, name: r.name, description: r.description, status: r.status, createdAt: r.created_at, via: r.via };
export const getCode = id => codeRow(q("SELECT * FROM codes WHERE id=?").get(String(id ?? "")));
export const activeCode = id => { const c = getCode(id); return c && c.status === "actif" ? c : null; };

/** Codes en vigueur, avec le nombre de lois et de propositions qu'ils réunissent. */
export function codesList() {
  const laws = Object.fromEntries(q("SELECT code_id id, COUNT(*) c FROM laws WHERE code_id IS NOT NULL AND status='vigueur' GROUP BY code_id").all().map(r => [r.id, r.c]));
  const props = Object.fromEntries(q("SELECT code_id id, COUNT(*) c FROM proposals WHERE code_id IS NOT NULL AND hidden=0 AND phase<>'fin' GROUP BY code_id").all().map(r => [r.id, r.c]));
  return q("SELECT * FROM codes WHERE status='actif'").all().map(codeRow)
    .map(c => ({ ...c, laws: laws[c.id] || 0, proposals: props[c.id] || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

function requestView(r, viewer) {
  const author = q("SELECT pseudo FROM users WHERE id=?").get(r.author_id)?.pseudo || "inconnu";
  const code = r.code_id ? getCode(r.code_id) : null;
  const out = {
    id: r.id, action: r.action, name: r.name, description: r.description, reason: r.reason, author, createdAt: r.created_at,
    endsAt: r.ends_at, rules: J(r.rules), status: r.status, code: code && { id: code.id, name: code.name, status: code.status },
    participation: q("SELECT COUNT(*) c FROM code_participations WHERE request_id=?").get(r.id).c,
    voted: !!viewer && !!q("SELECT 1 x FROM code_participations WHERE request_id=? AND user_id=?").get(r.id, viewer.id),
    isAuthor: viewer?.id === r.author_id
  };
  // Comme pour les lois, les résultats restent cachés jusqu'à la clôture.
  if (r.status !== "open") out.result = J(r.result);
  return out;
}
/** Demandes ouvertes et décisions récentes (toutes, ou celles d'un code). */
export function requestsList(viewer, codeId = null) {
  const where = codeId ? "WHERE code_id=?" : "", args = codeId ? [codeId] : [];
  const open = q(`SELECT * FROM code_requests ${where ? where + " AND" : "WHERE"} status='open' ORDER BY ends_at`).all(...args);
  const closed = q(`SELECT * FROM code_requests ${where ? where + " AND" : "WHERE"} status<>'open' ORDER BY ends_at DESC LIMIT 30`).all(...args);
  return { open: open.map(r => requestView(r, viewer)), closed: closed.map(r => requestView(r, viewer)) };
}

/* ---------- demandes ---------- */
const clean = (v, min, max, label) => {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  if (s.length < min) fail(400, min <= 1 ? `${label} est obligatoire.` : `${label} doit faire au moins ${min} caractères.`);
  if (s.length > max) fail(400, `${label} ne doit pas dépasser ${max} caractères.`);
  return s;
};
/** Un nom ne peut servir qu'à un seul code en vigueur, ni à deux demandes en cours. */
function nameTaken(name, exceptCode = null, exceptRequest = null) {
  const n = normQ(name);
  if (q("SELECT id, name FROM codes WHERE status='actif'").all().some(c => c.id !== exceptCode && normQ(c.name) === n)) return "Un code porte déjà ce nom.";
  if (q("SELECT id, name FROM code_requests WHERE status='open' AND action IN ('create','modify') AND name IS NOT NULL").all()
    .some(r => r.id !== exceptRequest && normQ(r.name) === n)) return "Une demande en cours propose déjà ce nom.";
  return null;
}

/** Dépose une demande de création, de modification ou de suppression d'un code. */
export function openRequest(user, b, checkContent) {
  const action = String(b.action || "");
  if (!ACTIONS[action]) fail(400, "Action inconnue : créer, modifier ou supprimer un code.");
  const reason = clean(b.reason, 5, 500, "La justification");
  let code = null, name = null, description = null;
  if (action !== "create") {
    code = activeCode(b.codeId); if (!code) fail(404, "Code introuvable.");
    if (q("SELECT 1 x FROM code_requests WHERE code_id=? AND status='open'").get(code.id)) fail(409, "Une demande est déjà en cours de vote sur ce code. Attends sa clôture.");
  }
  if (action !== "delete") {
    name = clean(b.name, 3, 60, "Le nom");
    description = String(b.description ?? "").trim().slice(0, 280);
    if (action === "modify" && name === code.name && description === code.description) fail(400, "Rien ne change : modifie le nom ou la description.");
    const taken = (action === "create" || normQ(name) !== normQ(code.name)) && nameTaken(name, code?.id);
    if (taken) fail(409, taken);
  }
  checkContent(reason, name || "", description || "");
  const r = cstNow().params, at = now(), id = uid(10);
  const rules = { days: r.codeDays, minVotes: r.codeMinVotes, majorityPct: r.majorityPct };
  q("INSERT INTO code_requests(id,action,code_id,name,description,reason,author_id,created_at,ends_at,rules) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, action, code?.id ?? null, name, description, reason, user.id, at, at + rules.days * DAY, S(rules));
  return { id };
}

export function voteRequest(user, id, choice, receipt) {
  const r = q("SELECT * FROM code_requests WHERE id=?").get(String(id));
  if (!r) fail(404, "Demande introuvable.");
  if (r.status !== "open" || r.ends_at <= now()) fail(409, "Le vote sur cette demande est clos.");
  if (choice !== null && !["p", "c"].includes(choice)) fail(400, "Choix de vote inconnu.");
  return tx(() => {
    if (!q("SELECT 1 x FROM code_participations WHERE request_id=? AND user_id=?").get(r.id, user.id)) {
      if (choice === null) fail(409, "Tu n'as pas encore voté sur cette demande.");
      const code = newReceipt();
      q("INSERT INTO code_participations(request_id,user_id,day) VALUES (?,?,?)").run(r.id, user.id, dayOf(now()));
      q("INSERT INTO code_ballots(request_id,ballot_id,choice) VALUES (?,?,?)").run(r.id, receiptHash(code), choice);
      return { ok: true, receipt: code };
    }
    if (!receipt) fail(409, "Tu as déjà voté. Pour changer ton vote, saisis le code de vote reçu au moment du vote.");
    const bid = receiptHash(receipt);
    if (!q("SELECT 1 x FROM code_ballots WHERE request_id=? AND ballot_id=?").get(r.id, bid)) fail(400, "Ce code ne correspond à aucun bulletin de cette demande.");
    if (choice === null) {
      q("DELETE FROM code_ballots WHERE request_id=? AND ballot_id=?").run(r.id, bid);
      q("DELETE FROM code_participations WHERE request_id=? AND user_id=?").run(r.id, user.id);
    } else q("UPDATE code_ballots SET choice=? WHERE request_id=? AND ballot_id=?").run(choice, r.id, bid);
    return { ok: true };
  });
}

/* ---------- clôture ---------- */
function apply(r, at) {
  const code = r.code_id ? getCode(r.code_id) : null;
  if (r.action !== "create" && (!code || code.status !== "actif")) return { ok: false, note: "Le code n'existait plus : rien à appliquer." };
  if (r.action !== "delete" && (r.action === "create" || normQ(r.name) !== normQ(code.name))) {
    const taken = nameTaken(r.name, code?.id, r.id);
    if (taken) return { ok: false, note: taken + " Rien n'est appliqué." };
  }
  if (r.action === "create") {
    const id = uid(8);
    q("INSERT INTO codes(id,name,description,status,created_at,via) VALUES (?,?,?,'actif',?,?)").run(id, r.name, r.description || "", at, r.id);
    q("UPDATE code_requests SET code_id=? WHERE id=?").run(id, r.id);
    return { ok: true, note: `Le code « ${r.name} » est créé.` };
  }
  if (r.action === "modify") {
    q("UPDATE codes SET name=?, description=? WHERE id=?").run(r.name, r.description || "", code.id);
    return { ok: true, note: code.name === r.name ? `La description du code « ${r.name} » est mise à jour.` : `Le code « ${code.name} » s'appelle désormais « ${r.name} ».` };
  }
  // Suppression : les lois et propositions restent, elles ne sont simplement plus rangées dans ce code.
  q("UPDATE codes SET status='supprime' WHERE id=?").run(code.id);
  q("UPDATE proposals SET code_id=NULL WHERE code_id=?").run(code.id);
  q("UPDATE laws SET code_id=NULL WHERE code_id=?").run(code.id);
  return { ok: true, note: `Le code « ${code.name} » est supprimé. Ses lois et propositions restent consultables.` };
}

function close(r, at) {
  const rules = J(r.rules), t = { p: 0, c: 0 };
  const what = r.action === "create" ? `créer le code « ${r.name} »` : `${ACTIONS[r.action]} le code « ${getCode(r.code_id)?.name || r.name} »`;
  for (const v of q("SELECT choice, COUNT(*) c FROM code_ballots WHERE request_id=? GROUP BY choice").all(r.id)) t[v.choice] = v.c;
  const ex = t.p + t.c, pourPct = ex ? Math.round(t.p * 1000 / ex) / 10 : 0;
  const voted = ex >= rules.minVotes && (t.p / ex) * 100 > rules.majorityPct;
  const applied = voted ? apply(r, at) : { ok: false, note: ex < rules.minVotes ? `Pas assez de votes (${ex} sur ${rules.minVotes} minimum).` : "La majorité a voté contre." };
  const result = { pour: t.p, contre: t.c, pourPct, closedAt: at, note: applied.note };
  q("UPDATE code_requests SET status=?, result=? WHERE id=?").run(applied.ok ? "adopted" : "rejected", S(result), r.id);
  journal(`Codes · demande pour ${what} ${applied.ok ? "adoptée" : "rejetée"} (${t.p} pour, ${t.c} contre). ${applied.note}`);
  notify(r.author_id, `Ta demande pour ${what} est ${applied.ok ? "adoptée" : "rejetée"}. ${applied.note}`, "#/codes");
}

/** Mode démo : clôture immédiate d'une demande. */
export function closeNow(id, at = now()) {
  const r = q("SELECT * FROM code_requests WHERE id=? AND status='open'").get(String(id));
  if (!r) fail(404, "Demande introuvable ou déjà close.");
  tx(() => close(r, at));
  return { ok: true };
}

/** Clôt les demandes arrivées à échéance. */
export function tickCodes(at = now()) {
  const due = q("SELECT * FROM code_requests WHERE status='open' AND ends_at<=?").all(at);
  for (const r of due) tx(() => close(r, r.ends_at));
  return due.length;
}
