// Tests unitaires des règles pures : IP du visiteur, types de fichiers, médiane des jurys,
// fusion des révisions, filtre de modération et anti-robot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../server/http.js";
import { matchesType } from "../server/api.js";
import { median } from "../server/moderation.js";
import { mergedCst, relativeToBase, validateCst } from "../public/shared/constitution.js";
import { moderate } from "../public/shared/moderation.js";
import { verify as verifyAntibot } from "../server/antibot.js";
import { DEFAULT_PARAMS, DEFAULT_FREE } from "../public/shared/constitution.js";

const req = (xff, ip = "10.0.0.2") => ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: ip } });

test("IP du visiteur : la dernière valeur de X-Forwarded-For, pas celle que le visiteur fournit", () => {
  assert.equal(clientIp(req("6.6.6.6, 203.0.113.9"), true), "203.0.113.9");
  assert.equal(clientIp(req("203.0.113.9"), true), "203.0.113.9");
  assert.equal(clientIp(req(undefined), true), "10.0.0.2");
});

test("IP du visiteur : sans proxy de confiance, l'en-tête est ignoré", () => {
  assert.equal(clientIp(req("6.6.6.6, 203.0.113.9"), false), "10.0.0.2");
});

test("fichiers joints : le contenu doit correspondre à l'extension", () => {
  assert.equal(matchesType("pdf", Buffer.from("%PDF-1.7 corps")), true);
  assert.equal(matchesType("pdf", Buffer.from("MZ\x90\x00 exécutable déguisé")), false);
  assert.equal(matchesType("png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), true);
  assert.equal(matchesType("jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(matchesType("webp", Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1")), true);
  assert.equal(matchesType("webp", Buffer.from("RIFF\x00\x00\x00\x00WAVEfmt ", "latin1")), false);
  assert.equal(matchesType("docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0])), true);
  assert.equal(matchesType("txt", Buffer.from("texte simple")), true);
  assert.equal(matchesType("txt", Buffer.from([0x41, 0x00, 0x42])), false);
});

test("médiane des jurys : la mesure médiane pour un nombre impair de votes", () => {
  assert.equal(median(["keep", "warn", "ban"]), "warn");
  assert.equal(median(["keep", "keep", "ban"]), "keep");
  assert.equal(median(["suspend7", "ban", "warn", "keep", "hide"]), "warn");
});

test("fusion des révisions : seul ce que la révision a changé est appliqué", () => {
  const base = { params: { ...DEFAULT_PARAMS, majorityPct: 50 }, free: { ...DEFAULT_FREE, principes: "A" } };
  const target = { params: { ...DEFAULT_PARAMS, majorityPct: 60 }, free: { ...DEFAULT_FREE, principes: "A" } };
  // La version en vigueur a changé le quorum entre-temps : la révision ne doit pas le défaire.
  const current = { params: { ...DEFAULT_PARAMS, majorityPct: 50, quorumPct: 8 }, free: { ...DEFAULT_FREE, principes: "B" } };
  const merged = mergedCst(base, target, current);
  assert.equal(merged.params.majorityPct, 60);
  assert.equal(merged.params.quorumPct, 8);
  assert.equal(merged.free.principes, "B");
});

test("relativeToBase : ne garde que les écarts par rapport à la version en vigueur", () => {
  const current = { params: { ...DEFAULT_PARAMS }, free: { ...DEFAULT_FREE } };
  const edited = { params: { ...DEFAULT_PARAMS, majorityPct: 55 }, free: { ...DEFAULT_FREE } };
  const rel = relativeToBase(edited, { params: { ...DEFAULT_PARAMS, majorityPct: 50 }, free: { ...DEFAULT_FREE } }, current);
  assert.equal(rel.params.majorityPct, 55);
});

test("validation de la Constitution : valeur hors bornes refusée", () => {
  const c = { params: { ...DEFAULT_PARAMS, majorityPct: 999 }, free: { ...DEFAULT_FREE } };
  assert.match(validateCst(c), /Majorité|doit être entre/);
  assert.equal(validateCst({ params: { ...DEFAULT_PARAMS }, free: { ...DEFAULT_FREE } }), null);
});

test("filtre de modération : retient insultes, menaces et données personnelles, laisse passer un argument", () => {
  assert.equal(moderate("Ce projet est une idée connard")?.kind, "insulte");
  assert.equal(moderate("écrivez à quelqu'un@exemple.fr")?.kind, "adresse e-mail");
  assert.equal(moderate("je vais te tuer")?.kind, "menace");
  assert.equal(moderate("Il faut réduire la durée du travail hebdomadaire à 32 heures."), null);
});

test("anti-robot : un champ piège rempli ou une preuve absente sont refusés", () => {
  assert.throws(() => verifyAntibot({ website: "http://spam" }), /anti-robot/);
  assert.throws(() => verifyAntibot({}), /anti-robot/);
});
