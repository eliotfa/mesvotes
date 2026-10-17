// Tests de bout en bout de l'API : un vrai serveur, une base en mémoire, l'horloge avancée à la main.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mesvotes-test-"));
process.env.INIT_PARRAINAGE_MIN = "2";
process.env.DEMO_MODE = "true";
process.env.BASE_URL = "http://localhost";

const { createServer, boot } = await import("../server/index.js");
const { clock } = await import("../server/model.js");
const { tick } = await import("../server/lifecycle.js");
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

function client() {
  let cookie = "";
  const call = async (method, url, body, { csrf = true, raw, headers = {} } = {}) => {
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
  const a = ok(await admin.post("/api/auth/register", { email: "admin@test.fr", pseudo: "admin", password: "motdepasse1" }));
  assert.equal(a.me.role, "admin");
  ok(await ana.post("/api/auth/register", { email: "ana@test.fr", pseudo: "ana", password: "motdepasse1" }));
  ok(await bob.post("/api/auth/register", { email: "bob@test.fr", pseudo: "bob", password: "motdepasse1", minor: true }));
  const c = ok(await cleo.post("/api/auth/register", { email: "cleo@test.fr", pseudo: "cleo", password: "motdepasse1" }));
  assert.equal(c.me.role, "user");
  assert.equal((await client().post("/api/auth/register", { email: "x@test.fr", pseudo: "ana", password: "motdepasse1" })).status, 409);
  assert.equal((await client().post("/api/auth/login", { email: "ana@test.fr", password: "mauvais" })).status, 401);
  assert.equal(ok(await admin.get("/api/bootstrap")).electorate, 4);
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

test("trois signalements masquent une contribution, la modération tranche", async () => {
  const r = ok(await ana.post("/api/proposals", { kind: "loi", title: "Sujet de débat animé", summary: "Une proposition pour tester les signalements.", text: "Texte de test pour la modération.", projetDays: 30, delibDays: 180 }));
  const n = ok(await bob.post(`/api/proposals/${r.id}/notes`, { type: "comment", text: "Une remarque désagréable mais polie." }));
  for (const c of [ana, cleo, admin]) ok(await c.post(`/api/notes/${n.id}/report`));
  let note = ok(await cleo.get(`/api/proposals/${r.id}`)).notes[0];
  assert.equal(note.masked, true);
  assert.equal(note.text, undefined);
  assert.equal(ok(await bob.get(`/api/proposals/${r.id}`)).notes[0].text, "Une remarque désagréable mais polie.");
  assert.equal((await cleo.get("/api/mod/queue")).status, 403);
  const q = ok(await admin.get("/api/mod/queue"));
  assert.equal(q.notes.length, 1);
  ok(await admin.post(`/api/mod/notes/${n.id}`, { action: "restore" }));
  note = ok(await cleo.get(`/api/proposals/${r.id}`)).notes[0];
  assert.equal(note.masked, false);
  const j = ok(await cleo.get("/api/journal")).items;
  assert.ok(j.some(x => /rétablie/.test(x.text)));
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
  assert.equal(ok(await ana.get("/api/proposals?author=cleo")).total, 3);
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
  ok(await z.post("/api/auth/register", { email: "zoe@test.fr", pseudo: "zoe", password: "motdepasse1" }));
  assert.equal((await z.patch("/api/me", { currentPassword: "faux", newPassword: "nouveau123" })).status, 401);
  ok(await z.patch("/api/me", { currentPassword: "motdepasse1", newPassword: "nouveau123" }));
  ok(await z.del("/api/me", { password: "nouveau123" }));
  assert.equal(ok(await z.get("/api/bootstrap")).me, null);
  assert.equal((await client().post("/api/auth/login", { email: "zoe@test.fr", password: "nouveau123" })).status, 401);
});
