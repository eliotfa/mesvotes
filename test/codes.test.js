// Tests de bout en bout des codes : création, modification et suppression décidées par un vote.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

process.env.NODE_ENV = "test";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mesvotes-codes-"));
process.env.INIT_PARRAINAGE_MIN = "2";
process.env.INIT_CODE_MIN_VOTES = "2";
process.env.BASE_URL = "http://localhost";
process.env.ANTIBOT_MIN_SECONDS = "0";
process.env.ANTIBOT_BITS = "12";

const { createServer, boot } = await import("../server/index.js");
const { clock } = await import("../server/model.js");
const { tick } = await import("../server/lifecycle.js");
const { tickCodes } = await import("../server/codes.js");

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
  const call = async (method, url, body) => {
    if (body && url === "/api/auth/register") body = { ...body, antibot: await solve() };
    const h = { "x-mesvotes": "1" }; if (cookie) h.cookie = cookie;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { get: u => call("GET", u), post: (u, b) => call("POST", u, b), patch: (u, b) => call("PATCH", u, b) };
}
const ok = r => { assert.ok(r.status < 300, `HTTP ${r.status} : ${JSON.stringify(r.data)}`); return r.data; };
const jump = days => { clock.offset += days * DAY; tick(); tickCodes(); };

const ana = client(), bob = client(), cleo = client();
let codeId;

test("inscriptions", async () => {
  for (const [c, p] of [[ana, "ana"], [bob, "bob"], [cleo, "cleo"]])
    ok(await c.post("/api/auth/register", { email: `${p}@test.fr`, pseudo: p, password: "motdepasse1", consent: true }));
});

test("créer un code passe par un vote des inscrits", async () => {
  assert.equal((await client().post("/api/codes/requests", { action: "create", name: "Code du travail", reason: "Réunir les textes sur le travail." })).status, 401);
  assert.equal((await ana.post("/api/codes/requests", { action: "create", name: "Co", reason: "Trop court." })).status, 400);
  const r = ok(await ana.post("/api/codes/requests", { action: "create", name: "Code du travail", description: "Emploi, salaires, conditions de travail.", reason: "Réunir les textes sur le travail." }));
  assert.equal((await bob.post("/api/codes/requests", { action: "create", name: "code du TRAVAIL", reason: "Doublon de nom." })).status, 409, "nom déjà demandé");
  ok(await ana.post(`/api/codes/requests/${r.id}/vote`, { choice: "p" }));
  ok(await bob.post(`/api/codes/requests/${r.id}/vote`, { choice: "c" }));
  ok(await bob.post(`/api/codes/requests/${r.id}/vote`, { choice: "p" })); // changement d'avis
  let list = ok(await cleo.get("/api/codes"));
  assert.equal(list.items.length, 0, "rien n'existe avant la clôture");
  assert.equal(list.requests.open[0].participation, 2);
  assert.equal(list.requests.open[0].result, undefined, "résultats cachés pendant le vote");
  jump(8);
  assert.equal((await cleo.post(`/api/codes/requests/${r.id}/vote`, { choice: "c" })).status, 409, "vote clos");
  list = ok(await cleo.get("/api/codes"));
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].name, "Code du travail");
  assert.equal(list.requests.closed[0].status, "adopted");
  assert.deepEqual([list.requests.closed[0].result.pour, list.requests.closed[0].result.contre], [2, 0]);
  codeId = list.items[0].id;
  assert.equal(ok(await cleo.get("/api/bootstrap")).codes[0].id, codeId);
});

test("une demande sans assez de votes est rejetée", async () => {
  const r = ok(await cleo.post("/api/codes/requests", { action: "create", name: "Code de la route", reason: "Réunir les textes sur la circulation." }));
  ok(await cleo.post(`/api/codes/requests/${r.id}/vote`, { choice: "p" }));
  jump(8);
  const list = ok(await cleo.get("/api/codes"));
  assert.equal(list.items.length, 1);
  assert.equal(list.requests.closed.find(x => x.id === r.id).status, "rejected");
});

test("une loi adoptée garde le code de sa proposition", async () => {
  assert.equal((await ana.post("/api/proposals", { kind: "loi", title: "Semaine de quatre jours", summary: "Passer à la semaine de quatre jours.", text: "La durée légale du travail est répartie sur quatre jours.", codeId: "inconnu", projetDays: 15, delibDays: 90 })).status, 400);
  const p = ok(await ana.post("/api/proposals", { kind: "loi", title: "Semaine de quatre jours", summary: "Passer à la semaine de quatre jours.", text: "La durée légale du travail est répartie sur quatre jours.", codeId, projetDays: 15, delibDays: 90 }));
  let d = ok(await bob.get(`/api/proposals/${p.id}`));
  assert.equal(d.code.name, "Code du travail");
  assert.equal(ok(await bob.get(`/api/proposals?code=${codeId}`)).total, 1);
  assert.equal((await bob.patch(`/api/proposals/${p.id}/meta`, { codeId: null, tags: "" })).status, 403, "seul le porteur range sa proposition");
  jump(16);
  for (const c of [ana, bob]) ok(await c.post(`/api/proposals/${p.id}/parrainage`, { on: true }));
  jump(91);
  for (const c of [ana, bob, cleo]) ok(await c.post(`/api/proposals/${p.id}/vote`, { choice: "p" }));
  jump(8);
  d = ok(await bob.get(`/api/proposals/${p.id}`));
  assert.equal(d.result.outcome, "adopted");
  const law = ok(await bob.get(`/api/laws/${d.lawId}`));
  assert.equal(law.codeId, codeId);
  const code = ok(await bob.get(`/api/codes/${codeId}`));
  assert.equal(code.laws.length, 1);
  assert.equal(code.laws[0].title, "Semaine de quatre jours");
});

test("renommer puis supprimer un code, sans supprimer ses textes", async () => {
  const m = ok(await bob.post("/api/codes/requests", { action: "modify", codeId, name: "Code du travail et de l'emploi", description: "Emploi, salaires.", reason: "Le nom doit couvrir l'emploi." }));
  assert.equal((await cleo.post("/api/codes/requests", { action: "delete", codeId, reason: "Une autre demande est en cours." })).status, 409, "une seule demande à la fois par code");
  for (const c of [ana, bob]) ok(await c.post(`/api/codes/requests/${m.id}/vote`, { choice: "p" }));
  jump(8);
  let code = ok(await ana.get(`/api/codes/${codeId}`));
  assert.equal(code.name, "Code du travail et de l'emploi");
  const del = ok(await cleo.post("/api/codes/requests", { action: "delete", codeId, reason: "Ce regroupement n'est plus utile." }));
  for (const c of [ana, bob, cleo]) ok(await c.post(`/api/codes/requests/${del.id}/vote`, { choice: "p" }));
  jump(8);
  code = ok(await ana.get(`/api/codes/${codeId}`));
  assert.equal(code.status, "supprime");
  assert.equal(code.laws.length, 0);
  assert.equal(ok(await ana.get("/api/codes")).items.length, 0);
  const laws = ok(await ana.get("/api/laws")).items;
  assert.equal(laws.length, 1, "la loi reste");
  assert.equal(laws[0].codeId, null);
});

test("la Constitution décrit les codes et leurs règles se révisent", async () => {
  const cst = ok(await ana.get("/api/constitution")).versions[0];
  assert.equal(cst.params.codeMinVotes, 2);
  assert.equal(cst.params.codeDays, 7);
});
