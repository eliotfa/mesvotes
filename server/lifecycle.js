// Cycle de vie automatique des propositions : Projet → Parrainage → Délibération → Vote → Résultat.
// Une horloge interne (tick) fait avancer les phases dès que leur échéance est passée.
import { q, tx, S } from "./db.js";
import { mergedCst } from "../public/shared/constitution.js";
import { MINOR_MIN } from "./ballot.js";
import {
  now, getProposal, saveProposalState, phaseEnd, threshold, electorate, lastVersion, lawFull, cstNow,
  needMaj, needQuo, uid
} from "./model.js";

const pct = (x, t) => t ? Math.round(x * 1000 / t) / 10 : 0;
const fr = v => String(v).replace(".", ",");

function tallies(id) {
  const t = { maj: { p: 0, c: 0, a: 0 }, min: { p: 0, c: 0, a: 0 } };
  for (const r of q("SELECT choice, minor, COUNT(*) c FROM ballots WHERE proposal_id=? GROUP BY choice, minor").all(id))
    t[r.minor ? "min" : "maj"][r.choice] = r.c;
  // Trop peu de mineurs : leur décompte à part dévoilerait leurs choix. On le fond dans le total.
  const nMin = t.min.p + t.min.c + t.min.a;
  if (nMin > 0 && nMin < MINOR_MIN) return { maj: { p: t.maj.p + t.min.p, c: t.maj.c + t.min.c, a: t.maj.a + t.min.a }, min: null, minorsMerged: true };
  return t;
}

function applyAdopted(p, result, at) {
  const v = lastVersion(p.id), share = `${fr(result.pourPct)} % pour`;
  if (p.kind === "loi") {
    const id = "l" + uid(8);
    q("INSERT INTO laws(id,title,themes,tags,status,created_at) VALUES (?,?,?,?,'vigueur',?)").run(id, p.title, S(p.themes), S(p.tags), at);
    q("INSERT INTO law_versions(law_id,n,date,text,note,via,abrog) VALUES (?,1,?,?,?,?,0)").run(id, at, v.text, `Adoptée par vote · ${share}`, p.id);
    p.lawId = id;
    return "La loi entre dans le recueil.";
  }
  if (p.kind === "modif" || p.kind === "abrog") {
    const law = lawFull(p.target.lawId);
    if (!law || law.status !== "vigueur") return "La loi visée n'était plus en vigueur : rien à appliquer.";
    const n = law.versions.length + 1;
    if (p.kind === "modif") {
      q("INSERT INTO law_versions(law_id,n,date,text,note,via,abrog) VALUES (?,?,?,?,?,?,0)").run(law.id, n, at, v.text, `Modification adoptée : « ${p.title} » · ${share}`, p.id);
      return `La loi passe en version ${n}.`;
    }
    q("UPDATE laws SET status='abrogée' WHERE id=?").run(law.id);
    q("INSERT INTO law_versions(law_id,n,date,text,note,via,abrog) VALUES (?,?,?,?,?,?,1)").run(law.id, n, at, law.versions[law.versions.length - 1].text, `Abrogée : « ${p.title} » · ${share}`, p.id);
    return "La loi est abrogée.";
  }
  const cur = cstNow(), m = mergedCst(p.constBase, v.cst, cur);
  q("INSERT INTO constitution(n,date,params,free,note,via) VALUES (?,?,?,?,?,?)").run(cur.n + 1, at, S(m.params), S(m.free), `Révision adoptée : « ${p.title} » · ${share}`, p.id);
  return `La Constitution passe en version ${cur.n + 1}.`;
}

function closeVote(p, at) {
  const votes = tallies(p.id), el = electorate();
  const m = votes.min || { p: 0, c: 0, a: 0 };
  const pour = votes.maj.p + m.p, contre = votes.maj.c + m.c, abst = votes.maj.a + m.a;
  const all = pour + contre + abst, ex = pour + contre;
  const pourPct = pct(pour, ex), participationPct = pct(all, el);
  const ok = ex > 0 && (pour / ex) * 100 > needMaj(p) && (all / el) * 100 >= needQuo(p);
  const result = { outcome: ok ? "adopted" : "rejected", votes, electorate: el, pourPct, participationPct, needMaj: needMaj(p), needQuo: needQuo(p), closedAt: at };
  if (ok) result.applied = applyAdopted(p, result, at);
  p.result = result;
}

/** Fait avancer une proposition d'une étape si l'échéance est passée (ou si force=true). */
export function step(p, at = now(), force = false) {
  if (p.phase === "fin") return false;
  const end = phaseEnd(p), due = at >= end;
  const when = force ? at : end;
  if (p.phase === "projet" && (due || force)) { p.phase = "parrainage"; p.dates.parrainage = when; }
  else if (p.phase === "parrainage") {
    const count = q("SELECT COUNT(*) c FROM parrainages WHERE proposal_id=?").get(p.id).c;
    if (count >= threshold(p) || force) { p.phase = "deliberation"; p.dates.deliberation = force ? at : Math.min(at, end); }
    else if (due) { p.phase = "fin"; p.dates.fin = end; p.result = { outcome: "expired", parrains: count, threshold: threshold(p), closedAt: end }; }
    else return false;
  }
  else if (p.phase === "deliberation" && (due || force)) { p.phase = "vote"; p.dates.vote = when; }
  else if (p.phase === "vote" && (due || force)) { p.phase = "fin"; p.dates.fin = when; closeVote(p, when); }
  else return false;
  saveProposalState(p);
  return true;
}

/** Vérifie une proposition (jusqu'à 5 étapes d'affilée si plusieurs échéances sont passées). */
export function settle(id, at = now()) {
  return tx(() => {
    const p = getProposal(id); if (!p) return null;
    let moved = 0; while (moved < 5 && step(p, at)) moved++;
    return p;
  });
}

export function tick(at = now()) {
  let changed = 0;
  for (const { id } of q("SELECT id FROM proposals WHERE phase<>'fin'").all()) {
    const before = q("SELECT phase FROM proposals WHERE id=?").get(id).phase;
    const p = settle(id, at);
    if (p && p.phase !== before) changed++;
  }
  return changed;
}

/** Mode démo : passage forcé à l'étape suivante. */
export function forceAdvance(id) {
  return tx(() => { const p = getProposal(id); if (!p) return null; step(p, now(), true); return p; });
}
