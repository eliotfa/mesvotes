// Tests de bout en bout de l'API : un vrai serveur, une base en mémoire, l'horloge avancée à la main.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

process.env.NODE_ENV = "test";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mesvotes-test-"));
process.env.INIT_PARRAINAGE_MIN = "2";
process.env.DEMO_MODE = "true";
process.env.BASE_URL = "http://localhost";
process.env.ANTIBOT_MIN_SECONDS = "0";
process.env.ANTIBOT_BITS = "12";

const { createServer, boot } = await import("../server/index.js");
const { clock } = await import("../server/model.js");
const { tick } = await import("../server/lifecycle.js");
const { tickModeration } = await import("../server/moderation.js");
const { resetRateLimits } = await import("../server/http.js");

const DAY = 864e5;
let server, base;

before(async () => {
  boot();
  server = createServer();
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

async function solve() {
  const c = await (await fetch(base + "/api/antibot")).json();
  for (let n = 0; ; n++) { const h = crypto.createHash("sha256").update(c.salt + n).digest(); if ((h.readUInt32BE(0) >>> (32 - c.bits)) === 0) return { ...c, nonce: String(n) }; }
}
function client() {
  let cookie = "";
  const call = async (method, url, body, { csrf = true, raw, headers = {}, antibot = true } = {}) => {
    if (antibot && body && /\/api\/auth\/(register|login|forgot)$/.test(url) && !body.antibot) body = { ...body, antibot: await solve() };
    const h = { ...headers }; if (cookie) h.cookie = cookie; if (csrf) h["x-mesvotes"] = "1";
    let payload;
    if (raw) payload = raw; else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] = "application/json"; }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: "manual" });
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { call, get: u => call("GET", u), post: (u, b, o) => call("POST", u, b, o), patch: (u, b) => call("PATCH", u, b), del: (u, b) => call("DELETE", u, b) };
}
const ok = r => { assert.ok(r.status < 300, `HTTP ${r.status} : ${JSON.stringify(r.data)}`); return r.data; };
const jump = days => { clock.offset += days * DAY; tick(); };

const admin = client(), ana = client(), bob = client(), cleo = client();

test("inscriptions : le premier compte est administrateur", async () => {
  resetRateLimits();
  const a = ok(await admin.post("/api/auth/register", { email: "admin@test.fr", pseudo: "admin", password: "motdepasse1", consent: true }));
  assert.equal(a.me.role, "admin");
  ok(await ana.post("/api/auth/register", { email: "ana@test.fr", pseudo: "ana", password: "motdepasse1", consent: true }));
  ok(await bob.post("/api/auth/register", { email: "bob@test.fr", pseudo: "bob", password: "motdepasse1", consent: true, minor: true }));
  const c = ok(await cleo.post("/api/auth/register", { email: "cleo@test.fr", pseudo: "cleo", password: "motdepasse1", consent: true }));
  assert.equal(c.me.role, "user");
  assert.equal((await client().post("/api/auth/register", { email: "x@test.fr", pseudo: "ana", password: "motdepasse1", consent: true })).status, 409);
  resetRateLimits();
  assert.equal((await client().post("/api/auth/register", { email: "y@test.fr", pseudo: "sansaccord", password: "motdepasse1" })).status, 400, "consentement obligatoire");
  assert.equal((await client().post("/api/auth/login", { email: "ana@test.fr", password: "mauvais" })).status, 401);
  assert.equal(ok(await admin.get("/api/bootstrap")).electorate, 4);
});

test("anti-robot : défi obligatoire, usage unique, champ piège", async () => {
  resetRateLimits();
  const c = client();
  assert.equal((await c.post("/api/auth/register", { email: "bot@test.fr", pseudo: "robot1", password: "motdepasse1", consent: true }, { antibot: false })).status, 400);
  const proof = await solve();
  assert.equal((await c.post("/api/auth/register", { email: "bot2@test.fr", pseudo: "robot2", password: "motdepasse1", consent: true, antibot: { ...proof, nonce: "999999999999" } }, { antibot: false })).status, 400, "mauvaise preuve");
  assert.equal((await c.post("/api/auth/register", { email: "bot3@test.fr", pseudo: "robot3", password: "motdepasse1", consent: true, website: "http://spam.example" })).status, 400, "champ piège rempli");
  ok(await c.post("/api/auth/login", { email: "ana@test.fr", password: "motdepasse1", antibot: proof }, { antibot: false }));
  assert.equal((await c.post("/api/auth/login", { email: "ana@test.fr", password: "motdepasse1", antibot: proof }, { antibot: false })).status, 400, "une preuve ne sert qu'une fois");
});

test("protection CSRF : une écriture sans en-tête est refusée", async () => {
  const r = await ana.post("/api/proposals", {}, { csrf: false });
  assert.equal(r.status, 403);
});

let loiId, lawId;
test("une loi suit tout le parcours jusqu'au recueil", async () => {
  const r = ok(await ana.post("/api/proposals", { kind: "loi", title: "Gratuité des musées le dimanche", summary: "Tous les musées nationaux gratuits le premier dimanche du mois.",
    text: "Les musées nationaux sont gratuits le premier dimanche du mois.\n\nL'État compense la perte de recettes.", themes: ["Culture"], tags: "musées, culture", projetDays: 15, delibDays: 90 }));
  loiId = r.id;
  // Amendement par bob, accepté par ana
  const n = ok(await bob.post(`/api/proposals/${loiId}/notes`, { type: "amend", text: "Tous les dimanches, c'est plus simple.", para: 1, proposed: "Les musées nationaux sont gratuits tous les dimanches." }));
  assert.equal((await bob.post(`/api/notes/${n.id}/decision`, { decision: "accept" })).status, 403);
  ok(await ana.post(`/api/notes/${n.id}/decision`, { decision: "accept" }));
  let d = ok(await cleo.get(`/api/proposals/${loiId}`));
  assert.equal(d.versions.length, 2);
  assert.match(d.versions[1].text, /tous les dimanches/);
  // Filtre de modération
  const bad = await cleo.post(`/api/proposals/${loiId}/notes`, { type: "comment", text: "Quel connard ce porteur" });
  assert.equal(bad.status, 422);
  assert.equal(bad.data.moderation.kind, "insulte");
  // Phases
  jump(16); d = ok(await cleo.get(`/api/proposals/${loiId}`));
  assert.equal(d.phase, "parrainage");
  assert.equal(d.threshold, 2);
  ok(await bob.post(`/api/proposals/${loiId}/parrainage`, { on: true }));
  const p = ok(await cleo.post(`/api/proposals/${loiId}/parrainage`, { on: true }));
  assert.equal(p.phase, "deliberation");
  assert.equal((await ana.post(`/api/proposals/${loiId}/versions`, { text: "Nouveau texte assez long.", note: "essai" })).status, 409);
  jump(91);
  ok(await ana.post(`/api/proposals/${loiId}/vote`, { choice: "p" }));
  ok(await bob.post(`/api/proposals/${loiId}/vote`, { choice: "c" }));
  ok(await bob.post(`/api/proposals/${loiId}/vote`, { choice: "p" })); // changement d'avis
  ok(await cleo.post(`/api/proposals/${loiId}/vote`, { choice: "c" }));
  d = ok(await cleo.get(`/api/proposals/${loiId}`));
  assert.equal(d.result, null, "les résultats restent cachés pendant le vote");
  assert.equal(d.participation, 3);
  jump(8);
  d = ok(await cleo.get(`/api/proposals/${loiId}`));
  assert.equal(d.phase, "fin");
  assert.equal(d.result.outcome, "adopted");
  assert.deepEqual(d.result.votes, { maj: { p: 1, c: 1, a: 0 }, min: { p: 1, c: 0, a: 0 } });
  lawId = d.lawId;
  const law = ok(await cleo.get(`/api/laws/${lawId}`));
  assert.equal(law.versions.length, 1);
  assert.equal(law.status, "vigueur");
});

async function fastTrack(id, votes) {
  jump(31);
  for (const c of [ana, bob, cleo]) await c.post(`/api/proposals/${id}/parrainage`, { on: true });
  jump(181);
  for (const [c, choice] of votes) ok(await c.post(`/api/proposals/${id}/vote`, { choice }));
  jump(11);
  return ok(await ana.get(`/api/proposals/${id}`));
}

test("une modification adoptée crée la version 2 de la loi", async () => {
  const lawText = ok(await ana.get(`/api/laws/${lawId}`)).versions[0].text;
  assert.equal((await bob.post("/api/proposals", { kind: "modif", lawId, title: "Modifier les musées", summary: "Rien ne change dans ce texte.", text: lawText, projetDays: 30, delibDays: 180 })).status, 400);
  const r = ok(await bob.post("/api/proposals", { kind: "modif", lawId, title: "Étendre aux musées régionaux", summary: "Les musées régionaux aussi.",
    text: lawText.replace("Les musées nationaux", "Les musées nationaux et régionaux"), projetDays: 30, delibDays: 180 }));
  const d = await fastTrack(r.id, [[ana, "p"], [bob, "p"], [cleo, "a"]]);
  assert.equal(d.result.outcome, "adopted");
  const law = ok(await ana.get(`/api/laws/${lawId}`));
  assert.equal(law.versions.length, 2);
  assert.match(law.versions[1].text, /nationaux et régionaux/);
});

test("une révision de la Constitution demande 60 % et change les règles", async () => {
  const cst = ok(await ana.get("/api/constitution")).versions[0];
  const r = ok(await cleo.post("/api/proposals", { kind: "const", title: "Voter pendant 10 jours", summary: "Deux week-ends pour voter.",
    text: "Une semaine, c'est court pour beaucoup de monde.", projetDays: 30, delibDays: 180, cst: { params: { ...cst.params, voteDays: 10 }, free: cst.free } }));
  const d = await fastTrack(r.id, [[ana, "p"], [bob, "p"], [cleo, "p"], [admin, "c"]]);
  assert.equal(d.result.outcome, "adopted"); // 75 % > 60 %
  const v = ok(await ana.get("/api/constitution")).versions;
  assert.equal(v.length, 2);
  assert.equal(v[1].params.voteDays, 10);
  assert.equal(v[1].params.parrainageMin, 2);
  // Une révision à 50 % échoue
  const r2 = ok(await cleo.post("/api/proposals", { kind: "const", title: "Parrainage à 5 parrains", summary: "Seuil minimum plus haut.",
    text: "Pour éviter les propositions trop légères.", projetDays: 30, delibDays: 180, cst: { params: { ...v[1].params, parrainageMin: 5 }, free: v[1].free } }));
  const d2 = await fastTrack(r2.id, [[ana, "p"], [bob, "c"]]);
  assert.equal(d2.result.outcome, "rejected");
  assert.equal(ok(await ana.get("/api/constitution")).versions.length, 2);
});

test("une abrogation adoptée retire la loi", async () => {
  const r = ok(await cleo.post("/api/proposals", { kind: "abrog", lawId, title: "Abroger la gratuité des musées", summary: "Les recettes manquent aux musées.", text: "Les musées ont besoin de ces recettes pour entretenir leurs collections.", projetDays: 30, delibDays: 180 }));
  await fastTrack(r.id, [[ana, "p"], [bob, "p"], [cleo, "p"]]);
  const law = ok(await ana.get(`/api/laws/${lawId}`));
  assert.equal(law.status, "abrogée");
  assert.equal(law.versions.length, 3);
});

test("sans assez de parrains, la proposition est archivée", async () => {
  const r = ok(await ana.post("/api/proposals", { kind: "loi", title: "Une idée peu soutenue", summary: "Personne ne parrainera ce texte.", text: "Texte de la proposition peu soutenue.", projetDays: 30, delibDays: 180 }));
  jump(31); jump(61);
  const d = ok(await ana.get(`/api/proposals/${r.id}`));
  assert.equal(d.phase, "fin");
  assert.equal(d.result.outcome, "expired");
});

const jurors = [];
test("modération citoyenne : jury tiré au sort, mesure médiane, suspension, appel", async () => {
  resetRateLimits();
  for (let i = 1; i <= 8; i++) {
    if (i === 5) resetRateLimits();
    const c = client(); ok(await c.post("/api/auth/register", { email: `j${i}@test.fr`, pseudo: `jure${i}`, password: "motdepasse1", consent: true })); jurors.push(c);
  }
  const r = ok(await ana.post("/api/proposals", { kind: "loi", title: "Sujet de débat animé", summary: "Une proposition pour tester la modération.", text: "Texte de test pour la modération.", projetDays: 30, delibDays: 180 }));
  const n = ok(await bob.post(`/api/proposals/${r.id}/notes`, { type: "comment", text: "Une remarque franchement désagréable." }));
  assert.equal((await bob.post("/api/reports", { type: "note", id: n.id, reason: "insulte" })).status, 400, "on ne signale pas sa propre contribution");
  ok(await ana.post("/api/reports", { type: "note", id: n.id, reason: "insulte", comment: "Attaque personnelle" }));
  assert.equal((await ana.post("/api/reports", { type: "note", id: n.id, reason: "insulte" })).status, 409, "un seul signalement par personne");
  ok(await cleo.post("/api/reports", { type: "note", id: n.id, reason: "harcelement" }));
  const third = ok(await admin.post("/api/reports", { type: "note", id: n.id, reason: "insulte" }));
  assert.ok(third.opened && third.caseId, "le 3e signalement ouvre une affaire");
  const caseId = third.caseId;
  // Pendant l'examen, la contribution est masquée pour les autres
  assert.equal(ok(await cleo.get(`/api/proposals/${r.id}`)).notes[0].text, undefined);
  assert.equal((await cleo.get(`/api/cases/${caseId}`)).status, 403, "l'affaire en cours est réservée aux jurés");
  // 7 jurés tirés au sort parmi les 8 inscrits non concernés
  const drawn = [];
  for (const c of jurors) { const m = ok(await c.get("/api/moderation")); if (m.duties.length) drawn.push(c); }
  assert.equal(drawn.length, 7);
  const d = ok(await drawn[0].get(`/api/cases/${caseId}`));
  assert.equal(d.snapshot.text, "Une remarque franchement désagréable.");
  assert.equal(d.comments[0].comment, "Attaque personnelle");
  // Votes : la médiane (4e sur 7, par ordre de sévérité) est « suspendre 7 jours »
  const votes = ["keep", "hide", "warn", "suspend7", "suspend7", "suspend7", "ban"];
  for (let i = 0; i < 7; i++) ok(await drawn[i].post(`/api/cases/${caseId}/vote`, { action: votes[i] }));
  const closed = ok(await bob.get(`/api/cases/${caseId}`));
  assert.equal(closed.status, "closed");
  assert.equal(closed.decision, "suspend7");
  assert.equal(closed.canAppeal, true);
  assert.equal(ok(await cleo.get(`/api/proposals/${r.id}`)).notes[0].removed, true);
  const bobMe = ok(await bob.get("/api/bootstrap")).me;
  assert.ok(bobMe.suspendedUntil > 0 && bobMe.unread > 0);
  assert.equal((await bob.post(`/api/proposals/${r.id}/notes`, { type: "comment", text: "Je peux encore écrire ?" })).status, 403, "suspendu : plus de participation");
  // Appel : nouveau jury élargi, sans les premiers jurés ; il décide de ne rien faire
  const ap = ok(await bob.post(`/api/cases/${caseId}/appeal`));
  assert.equal((await bob.post(`/api/cases/${caseId}/appeal`)).status, 409, "un seul appel");
  const second = jurors.find(c => !drawn.includes(c));
  const m2 = ok(await second.get("/api/moderation"));
  assert.equal(m2.duties[0].id, ap.caseId);
  ok(await second.post(`/api/cases/${ap.caseId}/vote`, { action: "keep" }));
  const final = ok(await bob.get(`/api/cases/${ap.caseId}`));
  assert.equal(final.decision, "keep");
  assert.equal(ok(await bob.get("/api/bootstrap")).me.suspendedUntil, 0, "la suspension est levée");
  assert.equal(ok(await cleo.get(`/api/proposals/${r.id}`)).notes[0].text, "Une remarque franchement désagréable.", "la contribution est rétablie");
  ok(await bob.post(`/api/proposals/${r.id}/notes`, { type: "comment", text: "Merci au jury d'appel." }));
  const pub = ok(await client().get("/api/moderation"));
  assert.equal(pub.closed.length, 2);
  assert.equal(pub.closed[0].snapshot, undefined, "le public ne voit pas le contenu");
  assert.ok(ok(await cleo.get("/api/journal")).items.some(x => /appel/.test(x.text)));
});

test("modération : sans quorum, le doute profite à l'auteur", async () => {
  const r = ok(await cleo.post("/api/proposals", { kind: "loi", title: "Proposition contestée", summary: "Une proposition signalée sans jury actif.", text: "Texte de la proposition contestée.", projetDays: 30, delibDays: 180 }));
  for (const c of [ana, bob, admin]) ok(await c.post("/api/reports", { type: "proposal", id: r.id, reason: "hors-sujet" }));
  assert.equal(ok(await ana.get(`/api/proposals/${r.id}`)).underReview, true);
  clock.offset += 73 * 3600e3; tickModeration();   // 1re échéance : prolongation
  clock.offset += 73 * 3600e3; tickModeration();   // 2e échéance : clôture
  const m = ok(await client().get("/api/moderation"));
  const c = m.closed.find(x => x.targetType === "proposal");
  assert.equal(c.decision, "keep");
  assert.match(c.note, /doute profite/);
  const d = ok(await ana.get(`/api/proposals/${r.id}`));
  assert.equal(d.underReview, false);
  assert.equal(d.hidden, false);
});

test("modération : signaler un compte", async () => {
  assert.equal((await bob.post("/api/reports", { type: "user", id: "bob", reason: "harcelement" })).status, 400);
  ok(await ana.post("/api/reports", { type: "user", id: "bob", reason: "harcelement", comment: "Messages répétés" }));
  assert.equal((await ana.post("/api/reports", { type: "user", id: "BOB", reason: "harcelement" })).status, 409);
  const prof = ok(await ana.get("/api/users/bob"));
  assert.equal(prof.myFlag, true);
  assert.equal(prof.pseudo, "bob");
});

test("suppression : un contenu masqué disparaît définitivement après N votes, pas avant", async () => {
  // Seuil par défaut : 5 votes. Auteur exclu, pas de vote sur un contenu visible.
  const r = ok(await bob.post("/api/proposals", { kind: "loi", title: "Proposition à retirer", summary: "Une proposition masquée en urgence.", text: "Texte de la proposition à retirer.", projetDays: 30, delibDays: 180 }));
  const n = ok(await ana.post(`/api/proposals/${r.id}/notes`, { type: "comment", text: "Une contribution masquée en urgence." }));
  assert.equal((await ana.post(`/api/deletions/note/${n.id}`, { on: true })).status, 409, "un contenu visible ne se vote pas pour la suppression");
  ok(await admin.post("/api/mod/urgent", { type: "note", id: n.id }));
  assert.equal((await ana.post(`/api/deletions/note/${n.id}`, { on: true })).status, 400, "on ne vote pas sur son propre contenu");
  const first = ok(await bob.post(`/api/deletions/note/${n.id}`, { on: true }));
  assert.deepEqual([first.deleted, first.votes], [false, 1]);
  assert.equal(ok(await bob.post(`/api/deletions/note/${n.id}`, { on: true })).votes, 1, "un seul vote par personne");
  const listed = ok(await cleo.get("/api/moderation")).masked.find(x => x.id === n.id);
  assert.ok(listed && listed.removed && listed.own === false && listed.mine === false && listed.votes === 1, "le contenu masqué est listé pour le vote");
  assert.equal(listed.author, undefined, "la liste ne révèle pas l'auteur");
  assert.equal(ok(await bob.post(`/api/deletions/note/${n.id}`, { on: false })).votes, 0, "on peut retirer son vote");
  for (const c of [bob, cleo, jurors[0], jurors[1]]) ok(await c.post(`/api/deletions/note/${n.id}`, { on: true }));
  assert.equal(ok(await cleo.get(`/api/proposals/${r.id}`)).notes.some(x => x.id === n.id), true, "quatre votes ne suffisent pas");
  const last = ok(await jurors[2].post(`/api/deletions/note/${n.id}`, { on: true }));
  assert.equal(last.deleted, true);
  assert.equal(ok(await cleo.get(`/api/proposals/${r.id}`)).notes.some(x => x.id === n.id), false, "la contribution est supprimée");
  assert.ok(ok(await cleo.get("/api/journal")).items.some(x => /supprimé définitivement/.test(x.text)));

  // Proposition masquée : le public la voit sans texte et peut voter ; la suppression efface tout.
  const p = ok(await bob.post("/api/proposals", { kind: "loi", title: "Titre à effacer", summary: "Résumé à effacer.", text: "Texte à effacer.", projetDays: 30, delibDays: 180 }));
  ok(await admin.post(`/api/mod/proposals/${p.id}`, { action: "hide" }));
  const masked = ok(await ana.get(`/api/proposals/${p.id}`));
  assert.equal(masked.masked, true);
  assert.equal(masked.title, undefined, "le public ne voit pas le titre");
  // Quatre votes : encore là. Le rétablissement efface les votes.
  for (const c of [ana, cleo, jurors[0], jurors[1]]) ok(await c.post(`/api/deletions/proposal/${p.id}`, { on: true }));
  assert.equal(ok(await ana.get(`/api/proposals/${p.id}`)).deletion.votes, 4);
  ok(await admin.post(`/api/mod/proposals/${p.id}`, { action: "restore" }));
  assert.equal(ok(await ana.get(`/api/proposals/${p.id}`)).deletion, undefined, "rétablie : plus de vote à afficher");
  ok(await admin.post(`/api/mod/proposals/${p.id}`, { action: "hide" }));
  assert.equal(ok(await ana.get(`/api/proposals/${p.id}`)).deletion.votes, 0, "les anciens votes ne comptent plus");
  // Cinq votes frais : la proposition disparaît, les liens vers elle aussi.
  for (const c of [ana, cleo, jurors[0], jurors[1], jurors[2]]) ok(await c.post(`/api/deletions/proposal/${p.id}`, { on: true }));
  assert.equal((await ana.get(`/api/proposals/${p.id}`)).status, 404);
  assert.equal(ok(await cleo.get("/api/moderation")).masked.some(x => x.id === p.id), false);
});

test("filtres et recherche", async () => {
  const all = ok(await ana.get("/api/proposals"));
  assert.ok(all.total >= 6);
  assert.equal(ok(await ana.get("/api/proposals?kind=const")).total, 2);
  const t = ok(await ana.get("/api/proposals?tag=" + encodeURIComponent("musées")));
  assert.equal(t.total, 1, JSON.stringify(t.items.map(i => i.title)));
  const s = ok(await ana.get("/api/proposals?q=GRATUITE%20dimanche"));
  // La recherche couvre aussi le titre de la loi visée : la loi, sa modification et son abrogation.
  assert.equal(s.total, 3, JSON.stringify(s.items.map(i => i.title)));
  assert.equal(ok(await ana.get("/api/proposals?q=dimanche%20introuvablexyz")).total, 0);
  assert.equal(ok(await ana.get("/api/proposals?author=cleo")).total, 4);
  assert.ok(ok(await ana.get("/api/proposals?mine=1")).items.every(p => p.author.pseudo === "ana"));
});

test("fichiers joints", async () => {
  const up = ok(await ana.post("/api/uploads", undefined, { raw: Buffer.from("%PDF-1.4 test"), headers: { "x-file-name": encodeURIComponent("étude.pdf"), "content-type": "application/pdf" } }));
  assert.equal(up.name, "étude.pdf");
  const res = await fetch(`${base}/files/${up.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  const bad = await ana.post("/api/uploads", undefined, { raw: Buffer.from("x"), headers: { "x-file-name": "script.exe" } });
  assert.equal(bad.status, 400);
});

test("mode démo : l'admin peut accélérer, pas les autres", async () => {
  const r = ok(await ana.post("/api/proposals", { kind: "loi", title: "Accélération de démo", summary: "Tester le bouton de démo.", text: "Texte de démonstration.", projetDays: 30, delibDays: 180 }));
  assert.equal((await ana.post(`/api/proposals/${r.id}/advance`)).status, 403);
  assert.equal(ok(await admin.post(`/api/proposals/${r.id}/advance`)).phase, "parrainage");
});

test("compte : changement de mot de passe et suppression", async () => {
  resetRateLimits();
  const z = client();
  ok(await z.post("/api/auth/register", { email: "zoe@test.fr", pseudo: "zoe", password: "motdepasse1", consent: true }));
  assert.equal((await z.patch("/api/me", { currentPassword: "faux", newPassword: "nouveau123" })).status, 401);
  ok(await z.patch("/api/me", { currentPassword: "motdepasse1", newPassword: "nouveau123" }));
  ok(await z.del("/api/me", { password: "nouveau123" }));
  assert.equal(ok(await z.get("/api/bootstrap")).me, null);
  assert.equal((await client().post("/api/auth/login", { email: "zoe@test.fr", password: "nouveau123" })).status, 401);
});

test("compte : changer de mot de passe déconnecte les autres appareils, pas celui qui le change", async () => {
  resetRateLimits();
  const phone = client(), laptop = client();
  ok(await phone.post("/api/auth/register", { email: "ida@test.fr", pseudo: "ida", password: "motdepasse1", consent: true }));
  ok(await laptop.post("/api/auth/login", { email: "ida@test.fr", password: "motdepasse1" }));
  ok(await phone.patch("/api/me", { currentPassword: "motdepasse1", newPassword: "nouveau456" }));
  assert.equal(ok(await phone.get("/api/bootstrap")).me?.pseudo, "ida");
  assert.equal(ok(await laptop.get("/api/bootstrap")).me, null);
});

test("fichiers joints : un contenu qui ne correspond pas à l'extension est refusé", async () => {
  resetRateLimits();
  const r = await ana.call("POST", "/api/uploads", undefined, { raw: Buffer.from("MZ\x90\x00 programme"), headers: { "x-file-name": encodeURIComponent("rapport.pdf") } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /ne correspond pas/);
});
