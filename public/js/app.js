// mesvotes.fr — interface web (application d'une seule page, sans dépendance).
import { esc, paras, parseTags, THEMES, PHASES, KINDS, DAY } from "../shared/util.js";
import { diffView } from "../shared/diff.js";
import { PARAMS, PMETA, FREE_KEYS, constArticles, constDiffs, paramChanges, n_, fmtParam, sanitizeCst, validateCst, MOD_ACTIONS, actionsFor, REPORT_REASONS } from "../shared/constitution.js";
import { moderate } from "../shared/moderation.js";
import { solveAntibot } from "./pow.js";

const PH = Object.fromEntries(PHASES.map((p, i) => [p.id, { ...p, i }]));
const $ = s => document.querySelector(s);
const fmtN = n => Number(n || 0).toLocaleString("fr-FR");
const fmtD = ts => new Date(ts).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const fmtDs = ts => new Date(ts).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" });
const daysLeft = end => Math.max(0, Math.ceil((end - Date.now()) / DAY));
const cvar = n => `var(${n})`;
const hue = s => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const initials = s => (s || "?").replace(/[^A-Za-zÀ-ÿ0-9]/g, "").slice(0, 2).toUpperCase() || "?";
const avatar = p => `<span class="avatar" style="background:hsl(${hue(p)} 45% 42%)" aria-hidden="true">${esc(initials(p))}</span>`;
const plural = (n, s, pl) => `${fmtN(n)} ${n > 1 ? (pl || s + "s") : s}`;
const pct = (x, t) => t ? Math.round(x * 1000 / t) / 10 : 0;
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------- état ---------- */
let BOOT = null;
const F0 = () => ({ q: "", kind: "", phase: "", theme: "", tag: "", author: "", from: "", to: "", only27: false, mine: false, sort: "avance" });
const UI = { f: F0(), showFilters: true, noteType: "comment", editing: false, editingTags: false, openVer: null, lawQ: "", lawStatus: "", newKind: "loi", prefill: null, after: "#/" };
let VIEW = null; // { name, data }
const me = () => BOOT && BOOT.me;
const cstNow = () => BOOT.constitution[BOOT.constitution.length - 1];
const isMod = () => me() && (me().role === "moderator" || me().role === "admin");
const isAdmin = () => me() && me().role === "admin";
const needsVerify = () => BOOT.mailEnabled && me() && !me().emailVerified;
const suspended = () => me() && me().suspendedUntil > Date.now();
const userLink = p => `<a class="ulink" href="#/u/${encodeURIComponent(p)}">@${esc(p)}</a>`;
const REASON_LABEL = Object.fromEntries(REPORT_REASONS);
const TYPE_LABEL = { note: "Contribution", proposal: "Proposition", user: "Compte" };
const actionLabel = (type, id) => (actionsFor(type).find(a => a.id === id) || MOD_ACTIONS.find(a => a.id === id) || { label: id }).label;

/* ---------- API ---------- */
class ApiError extends Error { constructor(status, body) { super(body.error || "Erreur"); this.status = status; this.body = body; } }
async function api(method, url, body, rawBody, headers = {}) {
  const opts = { method, credentials: "same-origin", headers: { "x-mesvotes": "1", ...headers } };
  if (rawBody) opts.body = rawBody;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  let res;
  try { res = await fetch(url, opts); } catch { throw new ApiError(0, { error: "Connexion impossible. Vérifie ton accès à internet." }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
async function loadBoot() { BOOT = await api("GET", "/api/bootstrap"); }

/* ---------- petits composants ---------- */
const errBox = (t, m) => `<div class="mod-msg" role="alert">${t ? `<b>${esc(t)}</b>` : ""}${esc(m)}</div>`;
function showError(box, e) {
  if (!box) { toast(e.message); return; }
  const mod = e.body && e.body.moderation;
  box.innerHTML = mod ? errBox("Message retenu par le filtre de modération", mod.msg) : errBox("", e.message);
  box.scrollIntoView({ block: "nearest" });
}
let toastT;
function toast(msg) {
  let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 3500);
}
const phaseChip = p => `<span class="phase" style="--c:${cvar(PH[p.phase].c)};color:var(--c)">${PH[p.phase].name}</span>`;
const kindChip = k => `<span class="kind ${k}">${KINDS[k].label}</span>`;
const numbered = (t, struck) => `<div class="text${struck ? " struck" : ""}">${paras(t).map((x, i) => `<div class="para"><span class="num">§${i + 1}</span><p>${esc(x)}</p></div>`).join("")}</div>`;
const diffStat = d => `<span class="diffstat"><span class="a">+${d.add}</span><span class="r">−${d.rem}</span><span class="muted">mots</span></span>`;
const paramTable = ch => `<div class="tablewrap"><table class="ptable"><thead><tr><th>Règle</th><th>Avant</th><th>Après</th></tr></thead><tbody>${ch.map(c => `<tr><td>${esc(PMETA[c.k].l)}</td><td class="v old">${fmtParam(c.k, c.from)}</td><td class="v new">${fmtParam(c.k, c.to)}</td></tr>`).join("")}</tbody></table></div>`;
const artDiffs = list => list.map(x => `<div class="art-diff" style="margin-top:12px"><h4>${esc(x.title)}</h4><div class="diff">${x.d.html}</div></div>`).join("");
const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
function durOptions(min, max, step, sel) {
  const set = new Set([min, max]); for (let v = Math.ceil(min / step) * step; v <= max; v += step) if (v >= min) set.add(v);
  const arr = [...set].sort((a, b) => a - b);
  const pick = arr.includes(sel) ? sel : arr.reduce((b, v) => Math.abs(v - sel) < Math.abs(b - sel) ? v : b, arr[0]);
  return arr.map(v => `<option value="${v}" ${v === pick ? "selected" : ""}>${v} jour${v > 1 ? "s" : ""}${v >= 60 && v % 30 === 0 ? ` (${v / 30} mois)` : ""}</option>`).join("");
}
const needMaj = p => p.kind === "const" ? p.rules.constMajorityPct : p.rules.majorityPct;
const needQuo = p => p.kind === "const" ? p.rules.constQuorumPct : p.rules.quorumPct;

/* ---------- en-tête ---------- */
function renderHeader() {
  const nav = [["#/", "Propositions", "home"], ["#/lois", "Lois", "laws"], ["#/constitution", "Constitution", "const"], ["#/2027", "2027", "y2027"], ["#/comment", "Comment ça marche", "how"]];
  nav.push(["#/moderation", `Modération${me()?.duties ? ` <span class="badge">${me().duties}</span>` : ""}`, "mod"]);
  if (isAdmin()) nav.push(["#/admin", "Admin", "admin"]);
  const cur = VIEW ? ({ detail: "home", new: "home", law: "laws", case: "mod" }[VIEW.name] || VIEW.name) : "";
  const u = me();
  $("#top").innerHTML = `<div class="wrap">
    <a class="brand" href="#/" aria-label="mesvotes.fr, accueil" style="text-decoration:none;color:inherit">
      <svg class="brand-mark" viewBox="0 0 30 30" aria-hidden="true"><rect x="2" y="12" width="26" height="16" rx="2" fill="var(--ink)"/><rect x="8" y="15.5" width="14" height="2.4" rx="1.2" fill="var(--surface)"/><rect x="9.5" y="2" width="11" height="13" rx="1" fill="var(--accent)" transform="rotate(-8 15 8)"/><path d="M12.2 8.2l2 2 4-4.2" stroke="var(--accent-ink)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="rotate(-8 15 8)"/></svg>
      <span class="brand-name">mes<span class="b-accent">votes</span><span class="b-tld">.fr</span></span>
    </a>
    <nav class="main" aria-label="Navigation">${nav.map(([h, l, k]) => `<a class="navbtn" href="${h}" aria-current="${cur === k}" style="text-decoration:none">${l}</a>`).join("")}</nav>
    <div class="top-actions">
      <a class="btn primary" href="#/proposer" style="text-decoration:none">Proposer</a>
      ${u ? `<a class="me-pill" href="#/compte" aria-label="Mon compte" style="text-decoration:none;color:inherit">${avatar(u.pseudo)}<span>${esc(u.pseudo)}</span>${u.minor ? '<span class="minor">-18</span>' : ""}${u.unread ? `<span class="badge" aria-label="${u.unread} notification(s)">${u.unread}</span>` : ""}</a>`
          : `<a class="btn" href="#/connexion" style="text-decoration:none;color:inherit">Se connecter</a>`}
    </div></div>`;
  const band = $("#band");
  const msgs = [];
  if (BOOT.demoMode) msgs.push(`<b>Démo</b><span>Ce serveur est en mode démo : les administrateurs peuvent accélérer le temps.</span>`);
  if (suspended()) msgs.push(`<b>Suspendu</b><span>Ton compte est suspendu jusqu'au ${fmtD(me().suspendedUntil)} par décision d'un jury citoyen. Tu peux lire et <a href="#/moderation" style="color:inherit">faire appel</a>.</span>`);
  if (me()?.duties) msgs.push(`<b>Jury</b><span>Tu as été tiré(e) au sort pour juger ${me().duties > 1 ? me().duties + " affaires" : "une affaire"} de modération. <a href="#/moderation" style="color:inherit">Donner mon avis</a></span>`);
  if (needsVerify()) msgs.push(`<b>E-mail</b><span>Confirme ton adresse pour proposer, parrainer et voter. <a href="#/compte" style="color:inherit">Renvoyer le lien</a></span>`);
  band.hidden = !msgs.length;
  band.innerHTML = msgs.length ? `<div class="wrap">${msgs.join("")}</div>` : "";
}

/* ---------- accueil ---------- */
function filterQuery() {
  const f = UI.f, P = new URLSearchParams();
  for (const k of ["q", "kind", "phase", "theme", "tag", "author", "from", "to", "sort"]) if (f[k]) P.set(k, f[k]);
  if (f.only27) P.set("only27", "1"); if (f.mine) P.set("mine", "1");
  return P.toString();
}
async function viewHome() {
  const data = await api("GET", "/api/proposals?" + filterQuery());
  VIEW = { name: "home", data };
  const r = cstNow().params, f = UI.f, c = data.phaseCounts || {};
  const durs = { projet: `${r.projetMin} à ${r.projetMax} jours`, parrainage: `${r.parrainageDays} jours max`, deliberation: `${r.delibMin} à ${r.delibMax} jours`, vote: `${r.voteDays} jours`, fin: "Archivé, consultable" };
  const act = activeFilters().length;
  return `
  <section class="hero">
    <h1>Votez pour des <span class="hl">idées.</span><br>Pas pour des hommes.</h1>
    <div>
      <p class="lede">N'importe qui propose une loi. Tout le monde peut l'améliorer. Si elle réunit assez de parrains, on prend des mois pour en débattre, puis on vote. Même les règles du jeu se votent.</p>
      <div class="stats">
        <div class="stat"><div class="n">${fmtN(BOOT.electorate)}</div><div class="l">inscrits</div></div>
        <div class="stat"><div class="n">${fmtN(BOOT.stats.proposals)}</div><div class="l">propositions</div></div>
        <div class="stat"><div class="n">${fmtN(BOOT.stats.lawsInForce)}</div><div class="l">lois en vigueur</div></div>
        <div class="stat"><div class="n">${fmtN(BOOT.stats.votesOpen)}</div><div class="l">vote${BOOT.stats.votesOpen > 1 ? "s" : ""} ouvert${BOOT.stats.votesOpen > 1 ? "s" : ""}</div></div>
      </div>
      <div class="btnrow"><a class="btn ink" href="#/comment" style="text-decoration:none">Comprendre le parcours</a><a class="btn" href="#/constitution" style="text-decoration:none;color:inherit">Lire la Constitution</a></div>
    </div>
  </section>
  ${goalHtml()}
  <div class="strip" role="group" aria-label="Filtrer par phase">
    ${PHASES.map((p, i) => `<button style="--c:${cvar(p.c)}" data-act="phasef" data-f="${p.id}" aria-pressed="${f.phase === p.id}">
      <span class="step">${i + 1}/5</span><span class="name">${p.name}</span><span class="dur">${durs[p.id]}</span><span class="count">${c[p.id] || 0}</span></button>`).join("")}
  </div>
  <div class="toolbar">
    <input class="search" id="q" type="search" placeholder="Chercher dans les titres, textes, tags, porteurs…" value="${esc(f.q)}" aria-label="Rechercher">
    <button class="chip-toggle" data-act="toggle-filters" aria-expanded="${UI.showFilters}">Filtres${act ? ` (${act})` : ""} ${UI.showFilters ? "▴" : "▾"}</button>
    <button class="chip-toggle" data-act="only27" aria-pressed="${f.only27}">Présidentielle 2027</button>
    ${me() ? `<button class="chip-toggle" data-act="mine" aria-pressed="${f.mine}">Mes propositions</button>` : ""}
  </div>
  ${UI.showFilters ? `<div class="filters" id="filters">
    <label>Type<select id="f-kind" data-f="kind"><option value="">Tous</option>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${f.kind === k ? "selected" : ""}>${v.label}</option>`).join("")}</select></label>
    <label>Phase<select id="f-phase" data-f="phase"><option value="">Toutes</option>${PHASES.map(p => `<option value="${p.id}" ${f.phase === p.id ? "selected" : ""}>${p.name}</option>`).join("")}</select></label>
    <label>Thème<select id="f-theme" data-f="theme"><option value="">Tous</option>${THEMES.map(t => `<option ${f.theme === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    <label>Tag<select id="f-tag" data-f="tag"><option value="">Tous</option>${data.facets.tags.map(([t, n]) => `<option value="${esc(t)}" ${f.tag === t ? "selected" : ""}>#${esc(t)} (${n})</option>`).join("")}</select></label>
    <label>Porteur<select id="f-author" data-f="author"><option value="">Tous</option>${data.facets.authors.map(a => `<option value="${esc(a)}" ${f.author === a ? "selected" : ""}>@${esc(a)}</option>`).join("")}</select></label>
    <label>Déposée après<input type="date" id="f-from" data-f="from" value="${esc(f.from)}"></label>
    <label>Déposée avant<input type="date" id="f-to" data-f="to" value="${esc(f.to)}"></label>
    <label>Trier par<select id="f-sort" data-f="sort">${[["avance", "Les plus avancées"], ["recent", "Les plus récentes"], ["ancien", "Les plus anciennes"], ["echeance", "Échéance la plus proche"], ["contrib", "Les plus débattues"], ["parrains", "Le plus de parrains"], ["titre", "Titre (A → Z)"]].map(([v, l]) => `<option value="${v}" ${f.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
  </div>
  ${data.facets.tags.length ? `<div class="tagcloud"><span class="lbl">Tags</span>${data.facets.tags.slice(0, 16).map(([t, n]) => `<button class="tagbtn" data-act="tagf" data-t="${esc(t)}" aria-pressed="${f.tag === t}">#${esc(t)}<span class="c">${n}</span></button>`).join("")}</div>` : ""}` : ""}
  <div class="active-filters" id="active">${activeHtml(data)}</div>
  <div class="list" id="list">${listHtml(data.items)}</div>`;
}
function goalHtml() {
  const goal = BOOT.goalMembers || 1000000, m = BOOT.stats.members || 0;
  const steps = [0, 100, 1000, 10000, 100000, goal];
  const fmtStep = v => v >= 1000000 ? `${n_(v / 1000000)} M` : fmtN(v);
  const next = steps.find(v => v > m) || goal;
  const pctGoal = m / goal * 100;
  return `<section class="goal" aria-labelledby="goal-t">
    <div class="goal-head"><div class="goal-kicker">Objectif</div><div class="goal-n" id="goal-t">${fmtN(goal)}</div><div class="goal-l">de membres</div></div>
    <div class="goal-body">
      <p>À un million de membres, nous fondons un parti politique ouvert à tous, dont le seul programme sera les propositions adoptées ici. Ses élus voteront ce que les membres auront décidé, rien d'autre.</p>
      <div class="goal-track" role="img" aria-label="${fmtN(m)} membres sur ${fmtN(goal)}, prochaine étape ${fmtN(next)}">
        ${steps.slice(1).map((v, i) => { const lo = steps[i]; const f = m >= v ? 100 : m <= lo ? 0 : (m - lo) / (v - lo) * 100; return `<div class="goal-seg"><span style="width:${f}%"></span></div>`; }).join("")}
      </div>
      <div class="goal-ticks">${steps.slice(1).map(v => `<span class="${m >= v ? "on" : ""}">${fmtStep(v)}</span>`).join("")}</div>
      <div class="goal-meta"><span><strong class="mono">${fmtN(m)}</strong> membre${m > 1 ? "s" : ""}</span><span>prochaine étape : ${fmtN(next)}</span><span>${pctGoal < 0.1 ? "moins de 0,1" : n_(Math.round(pctGoal * 10) / 10)} % de l'objectif</span><span class="muted">échelle par paliers</span></div>
      <div class="btnrow">${me() ? "" : `<a class="btn primary" href="#/inscription" style="text-decoration:none">Devenir membre</a>`}<button class="btn" data-act="share">Partager mesvotes.fr</button></div>
    </div></section>`;
}
function activeFilters() {
  const f = UI.f, out = [];
  if (f.kind) out.push(["kind", "Type", KINDS[f.kind].label]);
  if (f.phase) out.push(["phase", "Phase", PH[f.phase].name]);
  if (f.theme) out.push(["theme", "Thème", f.theme]);
  if (f.tag) out.push(["tag", "Tag", "#" + f.tag]);
  if (f.author) out.push(["author", "Porteur", "@" + f.author]);
  if (f.from) out.push(["from", "Déposée après", fmtD(new Date(f.from + "T12:00"))]);
  if (f.to) out.push(["to", "Déposée avant", fmtD(new Date(f.to + "T12:00"))]);
  if (f.only27) out.push(["only27", "Cahier", "Présidentielle 2027"]);
  if (f.mine) out.push(["mine", "Porteur", "moi"]);
  return out;
}
function activeHtml(data) {
  const a = activeFilters();
  return `<span class="count-line">${plural(data.total, "proposition")}</span>` +
    a.map(([k, l, v]) => `<button class="afchip" data-act="clearf" data-k="${k}">${l} : <b>${esc(v)}</b> ✕</button>`).join("") +
    (a.length || UI.f.q ? `<button class="btn ghost small" data-act="clearall">Tout effacer</button>` : "");
}
function listHtml(items) {
  if (!items.length) return `<div class="empty">Aucune proposition ne correspond.<br><a class="btn primary" href="#/proposer" style="margin-top:12px;text-decoration:none">Proposer une idée</a></div>`;
  return items.map(cardHtml).join("");
}
function chipsHtml(p, interactive) {
  const t = interactive
    ? p.themes.map(x => `<button class="tag theme" data-act="gofilter" data-k="theme" data-val="${esc(x)}">${esc(x)}</button>`).join("") + p.tags.map(x => `<button class="tag" data-act="gofilter" data-k="tag" data-val="${esc(x)}">#${esc(x)}</button>`).join("")
    : p.themes.map(x => `<span class="tag theme">${esc(x)}</span>`).join("") + p.tags.map(x => `<span class="tag">#${esc(x)}</span>`).join("");
  return `${kindChip(p.kind)}${phaseChip(p)}${p.is2027 ? '<span class="tag y27">2027</span>' : ""}${p.hidden ? '<span class="pill warn">masquée</span>' : ""}${t}`;
}
function cardFoot(p) {
  const c = cvar(PH[p.phase].c);
  if (p.phase === "projet") return `<span>Ouvert aux contributions</span><span class="mono">J-${daysLeft(p.phaseEnd)}</span>`;
  if (p.phase === "parrainage") return `<span class="bar" style="--c:${c}"><span style="width:${Math.min(100, p.parrains / p.threshold * 100)}%"></span></span><span class="mono">${fmtN(p.parrains)}/${fmtN(p.threshold)} parrains</span>`;
  if (p.phase === "deliberation") return `<span>Texte figé, débat en cours</span><span class="mono">vote dans ${daysLeft(p.phaseEnd)} j</span>`;
  if (p.phase === "vote") return `<span><strong>Vote ouvert</strong> · ${fmtN(p.participation)} votants</span><span class="mono">clôture J-${daysLeft(p.phaseEnd)}</span>`;
  const r = p.result || {};
  if (r.outcome === "expired") return `<span class="muted" style="font-weight:700">Archivée</span><span class="mono">parrainage insuffisant</span>`;
  const ok = r.outcome === "adopted";
  return `<span style="color:${ok ? "var(--pour)" : "var(--contre)"};font-weight:700">${ok ? "Adoptée" : "Rejetée"}</span><span class="mono">${n_(r.pourPct ?? 0)} % pour</span>`;
}
function cardHtml(p) {
  let target = "";
  if (p.targetTitle) target = `<span class="target">${p.kind === "modif" ? "Modifie" : "Abroge"} : <b>${esc(p.targetTitle)}</b></span>`;
  if (p.kind === "const" && p.constChanges) target = `<span class="target">Révise la Constitution${p.constChanges.length ? ` : <b>${p.constChanges.map(c => `${esc(PMETA[c.k].l)} ${fmtParam(c.k, c.from)} → ${fmtParam(c.k, c.to)}`).join(" · ")}</b>` : ""}</span>`;
  return `<a class="card" href="#/p/${p.id}" style="color:inherit;text-decoration:none">
    <span class="chips">${chipsHtml(p, false)}</span>
    <span class="ttl">${esc(p.title)}</span>${target}
    <span class="sum">${esc(p.summary)}</span>
    <span class="meta">${avatar(p.author.pseudo)}<span>@${esc(p.author.pseudo)}</span>${p.author.minor ? '<span class="minor">-18</span>' : ""}<span>· ${fmtDs(p.dates.projet)}</span><span>· v${p.versionsCount}</span><span>· ${plural(p.notesCount, "contribution")}</span>${p.attCount ? `<span>· ${plural(p.attCount, "pièce")}</span>` : ""}</span>
    <span class="card-foot" style="--c:${cvar(PH[p.phase].c)}">${cardFoot(p)}</span></a>`;
}
let qT;
async function refreshList() {
  try {
    const data = await api("GET", "/api/proposals?" + filterQuery());
    VIEW.data = data;
    const l = $("#list"), a = $("#active"); if (l) l.innerHTML = listHtml(data.items); if (a) a.innerHTML = activeHtml(data);
  } catch (e) { toast(e.message); }
}

/* ---------- détail ---------- */
const curV = d => d.versions[d.versions.length - 1];
const canAmend = d => d.phase === "projet" && (d.kind === "loi" || d.kind === "modif");
async function viewDetail(id) {
  const d = await api("GET", "/api/proposals/" + encodeURIComponent(id));
  VIEW = { name: "detail", data: d };
  return detailHtml(d);
}
/** Bouton de vote pour la suppression définitive d'un contenu masqué. */
function delVoteBtn(type, id, s, own) {
  if (!me()) return "";
  if (own) return `<span class="muted" style="font-size:13px">Ton contenu : tu ne peux pas voter dessus.</span>`;
  return `<button class="btn small ghost" data-act="del-vote" data-type="${type}" data-id="${esc(id)}" data-on="${s.mine ? 0 : 1}" aria-pressed="${s.mine}">${s.mine ? "✓ Pour la suppression · retirer" : "Voter pour la supprimer"} · ${s.votes}/${s.threshold}</button>`;
}
function maskedHtml(d) {
  return `
  <a class="btn ghost small back" href="#/" style="text-decoration:none">← Toutes les propositions</a>
  <div class="notice warn">Cette proposition a été masquée par décision d'un jury citoyen ou de l'administration. Son contenu n'est plus visible du public.</div>
  <div class="section"><h2>Supprimer définitivement ?</h2>
    <p class="muted" style="margin:0 0 10px;font-size:13px">Un contenu masqué disparaît définitivement dès ${d.deletion.threshold} inscrits votent pour sa suppression. Son auteur ne vote pas.</p>
    ${me() ? delVoteBtn("proposal", d.id, d.deletion, d.isAuthor) : `<a class="btn small" href="#/connexion" style="text-decoration:none">Se connecter pour voter</a>`}
  </div>`;
}
function detailHtml(d) {
  if (d.masked) return maskedHtml(d);
  const tagEdit = UI.editingTags && d.isAuthor;
  return `
  <a class="btn ghost small back" href="#/" style="text-decoration:none">← Toutes les propositions</a>
  ${d.hidden ? `<div class="notice warn">Cette proposition a été masquée par décision d'un jury citoyen ou de l'administration. Elle n'est plus visible du public.</div>` : ""}
  ${d.underReview && !d.hidden ? `<div class="notice">Cette proposition a été signalée : un jury citoyen tiré au sort l'examine. Elle reste visible pendant l'examen.</div>` : ""}
  <div class="detail">
    <div>
      <div class="chips">${chipsHtml(d, true)}${d.phase === "projet" && d.isAuthor && !tagEdit ? `<button class="btn small ghost" data-act="edit-tags">Gérer thèmes et tags</button>` : ""}</div>
      ${tagEdit ? `<form class="stack" data-form="tags" style="margin-top:12px;max-width:600px">
        ${d.kind === "const" ? "" : `<div class="f">Thèmes<div class="checks">${THEMES.filter(t => t !== "Constitution").map(t => `<label><input type="checkbox" name="theme" value="${t}" ${d.themes.includes(t) ? "checked" : ""}> ${t}</label>`).join("")}</div></div>`}
        <label class="f">Tags <small>6 maximum, séparés par des virgules ou des espaces.</small><input type="text" id="t-tags" value="${esc(d.tags.join(", "))}"></label>
        <div class="form-msg"></div>
        <div class="btnrow"><button class="btn primary small" type="submit">Enregistrer</button><button class="btn ghost small" type="button" data-act="cancel-tags">Annuler</button></div></form>` : ""}
      <h1 class="dtitle">${esc(d.title)}</h1>
      <p class="summary">${esc(d.summary)}</p>
      <div class="meta" style="margin-bottom:20px">${avatar(d.author.pseudo)}<span>Portée par ${userLink(d.author.pseudo)}</span>${d.author.minor ? '<span class="minor">-18</span>' : ""}<span>· déposée le ${fmtD(d.dates.projet)}</span>
        ${d.fork ? `<span>· variante de <a href="#/p/${d.fork.id}">${esc(d.fork.title)}</a></span>` : ""}
        ${d.lawId ? `<span>· devenue <a href="#/loi/${d.lawId}">une loi</a></span>` : ""}</div>
      ${textSections(d)}
      ${historyHtml(d)}
      ${d.files.length || d.links.length ? `<section class="section"><h2>Pièces jointes et sources</h2><div class="att">
        ${d.files.map(f => `<a href="/files/${f.id}" target="_blank" rel="noopener"><span class="k">${esc((f.name.split(".").pop() || "").slice(0, 4))}</span>${esc(f.name)} <span class="muted">${Math.max(1, Math.round(f.size / 1000))} ko</span></a>`).join("")}
        ${d.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"><span class="k">lien</span>${esc(l.label || l.url)} ↗</a>`).join("")}</div></section>` : ""}
      ${d.variants.length ? `<section class="section"><h2>Variantes · ${d.variants.length}</h2><ul class="mini">${d.variants.map(v => `<li><a href="#/p/${v.id}" class="minilink"><span class="t">${esc(v.title)}</span> <span class="meta">${phaseChip(v)} @${esc(v.author.pseudo)}</span></a></li>`).join("")}</ul></section>` : ""}
      <section class="section" id="discussion">
        <h2><span>${d.phase === "projet" ? "Construction collective" : d.phase === "fin" ? "Archives du débat" : "Débat"} · ${d.notes.filter(n => !n.removed).length}</span></h2>
        ${noteForm(d)}
        <div>${d.notes.slice().sort((a, b) => b.date - a.date).map(n => noteHtml(d, n)).join("") || `<p class="muted" style="margin:12px 0 0">Aucune contribution pour l'instant.</p>`}</div>
      </section>
    </div>
    <aside class="side">${sideHtml(d)}</aside>
  </div>`;
}
function editForm(d) {
  const tail = `<label class="f">Ce qui change dans cette version <small>Visible dans l'historique.</small><input type="text" id="edit-note" required maxlength="140" placeholder="Ex. : ajout d'un paragraphe sur le financement"></label>
    <div class="form-msg"></div>
    <div class="btnrow"><button class="btn primary" type="submit">Publier la version ${d.versions.length + 1}</button><button class="btn ghost" type="button" data-act="cancel-edit">Annuler</button></div>`;
  if (d.kind === "const") return `<form class="stack" data-form="edit">${cstEditor(cstNow(), d.merged, "e")}
    <label class="f">Exposé des motifs<textarea id="edit-text" rows="5" required>${esc(curV(d).text)}</textarea></label>${tail}</form>`;
  return `<form class="stack" data-form="edit">
    <label class="f">${d.kind === "abrog" ? "Exposé des motifs" : "Texte"} <small>Un paragraphe par bloc, séparés par une ligne vide.</small><textarea id="edit-text" rows="10" required>${esc(curV(d).text)}</textarea></label>${tail}</form>`;
}
function textSections(d) {
  const editing = UI.editing && d.isAuthor && d.phase === "projet", canEdit = d.phase === "projet" && d.isAuthor && !editing;
  const editBtn = canEdit ? `<button class="btn small" data-act="edit">Modifier</button>` : (d.phase !== "projet" ? `<span>figé</span>` : "");
  const text = curV(d).text;
  if (d.kind === "loi") return `<section class="section"><h2><span>Le texte · version ${d.versions.length}</span>${editBtn}</h2>${editing ? editForm(d) : numbered(text)}</section>`;
  if (d.kind === "modif") {
    const l = d.law, lv = l.versions.length, lt = l.versions[lv - 1].text, df = diffView(d.phase === "fin" ? (l.versions[d.target.base - 1] || l.versions[0]).text : lt, text);
    const warn = d.phase === "fin" ? "" : l.status !== "vigueur" ? `<div class="conflict">Cette loi a été abrogée depuis. La modification ne pourra pas s'appliquer.</div>` :
      lv !== d.target.base ? `<div class="conflict">La loi a changé depuis le dépôt (v${d.target.base} → v${lv}). Les différences sont calculées sur la version en vigueur. En cas d'adoption, ce texte remplacera la v${lv}.</div>` : "";
    return `<section class="section"><h2><span>Ce qui change dans la loi</span>${diffStat(df)}</h2>${warn}
      <p style="margin:0 0 10px;font-size:14px">Par rapport à <a href="#/loi/${l.id}">${esc(l.title)}</a> (v${d.phase === "fin" ? d.target.base : lv}).</p><div class="diff">${df.html}</div></section>
      <section class="section"><h2><span>Texte proposé · version ${d.versions.length}</span>${editBtn}</h2>${editing ? editForm(d) : numbered(text)}</section>`;
  }
  if (d.kind === "abrog") {
    const l = d.law, lt = l.versions[l.versions.length - 1].text;
    return `<section class="section"><h2><span>Loi visée par l'abrogation</span><span>${l.status === "vigueur" ? `v${l.versions.length} en vigueur` : "abrogée"}</span></h2>
      <p style="margin:0 0 10px;font-size:14px"><a href="#/loi/${l.id}">${esc(l.title)}</a></p>${numbered(lt, true)}</section>
      <section class="section"><h2><span>Exposé des motifs · version ${d.versions.length}</span>${editBtn}</h2>${editing ? editForm(d) : numbered(text)}</section>`;
  }
  const cur = cstNow();
  const from = d.merged ? cur : { params: d.constBase.params, free: d.constBase.free };
  const to = d.merged || curV(d).cst;
  const pc = paramChanges(from, to), ad = constDiffs(from, to);
  const warn = d.merged && cur.n !== d.constBase.v ? `<div class="conflict">La Constitution a changé depuis le dépôt (v${d.constBase.v} → v${cur.n}). Seules les règles modifiées par cette proposition s'appliqueront, comme une fusion de versions.</div>` : "";
  return `<section class="section"><h2><span>Ce qui change dans la Constitution</span>${canEdit ? `<button class="btn small" data-act="edit">Modifier la révision</button>` : `<span>${d.merged ? `par rapport à la v${cur.n}` : `par rapport à la v${d.constBase.v}`}</span>`}</h2>${warn}
    ${editing ? editForm(d) : (pc.length ? paramTable(pc) : "") + (artDiffs(ad) || `<p class="muted" style="margin:0">Aucun changement par rapport à la version en vigueur.</p>`)}</section>
    ${editing ? "" : `<section class="section"><h2><span>Exposé des motifs · version ${d.versions.length}</span></h2>${numbered(text)}</section>`}`;
}
function historyHtml(d) {
  if (d.versions.length < 2) return "";
  return `<section class="section"><h2><span>Historique · ${plural(d.versions.length, "version")}</span></h2><ul class="hist">${d.versions.slice().reverse().map(v => {
    const key = `p:${d.id}:${v.n}`, open = UI.openVer === key, prev = d.versions[v.n - 2];
    let body = "";
    if (open && prev) {
      if (d.kind === "const") {
        const pc = paramChanges(prev.cst, v.cst), td = diffView(prev.text, v.text);
        body = (pc.length ? paramTable(pc) : "") + artDiffs(constDiffs(prev.cst, v.cst)) + (td.changed ? artDiffs([{ title: "Exposé des motifs", d: td }]) : "");
      } else body = `<div class="diff">${diffView(prev.text, v.text).html}</div>`;
    }
    return `<li><div class="row"><span class="v">v${v.n}</span><span>${esc(v.note)} <span class="muted">· ${fmtD(v.date)}</span></span>${prev ? `<button class="btn small ghost" data-act="ver" data-k="${key}" aria-expanded="${open}">${open ? "Masquer" : "Voir les changements"}</button>` : "<span></span>"}</div>${body}</li>`;
  }).join("")}</ul></section>`;
}
function noteForm(d) {
  if (d.phase === "fin") return `<p class="muted" style="margin:0 0 6px;font-size:14px">Le vote est clos. Tout l'historique reste consultable.</p>`;
  if (!me()) return `<p style="margin:0 0 6px;font-size:14px"><a class="btn small" href="#/connexion" data-act="login-then">Se connecter</a> <span class="muted">pour commenter${canAmend(d) ? ", proposer un amendement" : ""} ou ajouter une source.</span></p>`;
  if (needsVerify()) return `<p class="muted" style="margin:0 0 6px;font-size:14px">Confirme ton adresse e-mail pour participer au débat.</p>`;
  const types = [["comment", "Commentaire"], ["source", "Source"]];
  if (canAmend(d)) types.splice(1, 0, ["amend", "Amendement"]);
  if (!types.some(t => t[0] === UI.noteType)) UI.noteType = "comment";
  const ps = paras(curV(d).text);
  return `<form class="stack" data-form="note" style="margin-bottom:8px">
    <div class="seg" role="radiogroup" aria-label="Type de contribution">${types.map(([v, l]) => `<label><input type="radio" name="ntype" value="${v}" ${UI.noteType === v ? "checked" : ""} data-act="ntype"> ${l}</label>`).join("")}</div>
    ${UI.noteType === "amend" ? `<label class="f">Paragraphe visé<select id="n-para">${ps.map((t, i) => `<option value="${i + 1}">§${i + 1} · ${esc(t.slice(0, 50))}…</option>`).join("")}<option value="${ps.length + 1}">Nouveau paragraphe (§${ps.length + 1})</option></select></label>
      <label class="f">Nouvelle rédaction proposée <small>Pré-remplie avec le texte actuel : modifie-la directement.</small><textarea id="n-proposed" rows="3" required maxlength="4000">${esc(ps[0] || "")}</textarea></label>` : ""}
    <label class="f">${UI.noteType === "amend" ? "Pourquoi ce changement" : UI.noteType === "source" ? "La source et ce qu'elle apporte" : "Ton commentaire"}<textarea id="n-text" rows="3" required maxlength="3000" placeholder="${UI.noteType === "source" ? "Colle un lien et résume ce qu'il montre." : "On débat des idées, pas des personnes."}"></textarea></label>
    <div class="form-msg"></div>
    <div><button class="btn primary small" type="submit">Publier</button></div></form>`;
}
function noteHtml(d, n) {
  const typeLbl = { comment: "Commentaire", amend: "Amendement", source: "Source" }[n.type];
  const stLbl = { pending: "En attente du porteur", accepted: "Intégré au texte", refused: "Non retenu" };
  let body;
  if (n.removed) body = `<p class="hidden-note">Retiré par décision d'un jury citoyen.</p>`;
  else if (n.masked && n.text === undefined) body = `<p class="hidden-note">Masqué pendant l'examen par un jury citoyen tiré au sort.</p>`;
  else body = `${n.masked ? `<p class="hidden-note">Masqué pour les autres pendant l'examen par un jury citoyen.</p>` : ""}
    ${n.type === "amend" ? `<div class="amend-box"><div class="lbl">${n.base ? "Changement proposé" : "Paragraphe ajouté"}</div><div class="diff">${diffView(n.base || "", n.proposed).html}</div></div>` : ""}<p>${linkify(n.text)}</p>`;
  const canReport = me() && !n.mine && !n.removed && !n.masked;
  return `<article class="note">${avatar(n.author)}<div class="body">
    <div class="head"><strong>${userLink(n.author)}</strong>${n.minor ? '<span class="minor">-18</span>' : ""}<span class="ntype ${n.type}">${typeLbl}${n.type === "amend" ? " §" + n.para : ""}</span><span>${fmtD(n.date)}</span>${n.type === "amend" ? `<span class="status ${n.status}">${stLbl[n.status]}</span>` : ""}</div>
    ${body}
    <div class="note-actions">
      ${n.type === "amend" && n.status === "pending" && d.phase === "projet" && d.isAuthor ? `<button class="btn small" data-act="decide" data-n="${n.id}" data-v="accept">Intégrer au texte</button><button class="btn small ghost" data-act="decide" data-n="${n.id}" data-v="refuse">Ne pas retenir</button>` : ""}
      ${canReport ? `<button class="btn small ghost" data-act="report" data-type="note" data-id="${n.id}" ${n.myReport ? "disabled" : ""}>${n.myReport ? "Signalé" : "Signaler"}</button>` : ""}
      ${n.deletion && !n.underReview ? delVoteBtn("note", n.id, n.deletion, n.mine) : ""}
    </div></div></article>`;
}
function timelineHtml(d) {
  const ci = PH[d.phase].i, r = d.rules;
  const dates = {
    projet: `${fmtD(d.dates.projet)} · ${d.projetDays} j`,
    parrainage: d.dates.parrainage ? `${fmtD(d.dates.parrainage)} · ${r.parrainageDays} j max` : `Seuil : ${fmtN(d.threshold)} parrains`,
    deliberation: d.dates.deliberation ? `${fmtD(d.dates.deliberation)} · ${d.delibDays} j` : `${d.delibDays} j prévus`,
    vote: d.dates.vote ? `${fmtD(d.dates.vote)} → ${fmtD(d.dates.vote + r.voteDays * DAY)}` : `${r.voteDays} jours`,
    fin: d.dates.fin ? fmtD(d.dates.fin) : "Publié à la clôture"
  };
  return `<ol class="timeline">${PHASES.map((ph, i) => `<li class="${i < ci || d.phase === "fin" ? "done" : i === ci ? "now" : ""}" style="--c:${cvar(ph.c)}"><span class="dot"></span><div><div class="t">${ph.name}</div><div class="s">${dates[ph.id]}</div></div></li>`).join("")}</ol>
  <p class="muted" style="font-size:12px;margin:4px 0 0">Suit les règles de la Constitution v${d.constV}, en vigueur au dépôt.</p>`;
}
function sideHtml(d) {
  const c = cvar(PH[d.phase].c), u = me();
  const loginBtn = l => `<a class="btn primary" href="#/connexion" data-act="login-then" style="text-decoration:none">${l}</a>`;
  let a = "";
  if (d.phase === "projet") {
    a = `<h3 style="color:${c}">Construction</h3><p>Pendant ${daysLeft(d.phaseEnd)} jour${daysLeft(d.phaseEnd) > 1 ? "s" : ""} encore, tout le monde peut ${canAmend(d) ? "annoter, sourcer et proposer des amendements" : "commenter et apporter des sources"}. Le porteur décide de ce qu'il intègre. Tout reste visible.</p>
      <button class="btn" data-act="scroll-disc">Contribuer</button>`;
  } else if (d.phase === "parrainage") {
    a = `<h3 style="color:${c}">Parrainage</h3>
      <div class="big-n">${fmtN(d.parrains)} <span style="font-size:18px;color:var(--muted)">/ ${fmtN(d.threshold)}</span></div>
      <div class="bar" style="--c:${c};margin:10px 0 8px;height:8px"><span style="width:${Math.min(100, d.parrains / d.threshold * 100)}%"></span></div>
      <p>Il faut ${fmtN(d.threshold)} parrains (${n_(d.rules.parrainagePct)} % des inscrits, minimum ${d.rules.parrainageMin}) d'ici ${daysLeft(d.phaseEnd)} jours.</p>
      ${u ? `<button class="btn ${d.myParrain ? "" : "primary"}" data-act="parrain" ${needsVerify() ? "disabled" : ""}>${d.myParrain ? "✓ Tu parraines · retirer" : "Parrainer cette proposition"}</button>` : loginBtn("Se connecter pour parrainer")}
      <p style="margin:10px 0 0;font-size:12px">Parrainer ne veut pas dire être pour. Ça veut dire : « ce sujet mérite un vote ».</p>`;
  } else if (d.phase === "deliberation") {
    a = `<h3 style="color:${c}">Délibération</h3>
      <div class="big-n">${daysLeft(d.phaseEnd)} <span style="font-size:18px;color:var(--muted)">jours avant le vote</span></div>
      <p style="margin-top:10px">Le texte (version ${d.versions.length}) est figé. C'est le temps de lire, de comparer les arguments, d'en parler autour de soi. Le vote ouvrira le ${fmtD(d.phaseEnd)}.</p>
      <button class="btn" data-act="scroll-disc">Lire le débat</button>`;
  } else if (d.phase === "vote") {
    const opts = [["p", "Pour", "--pour"], ["c", "Contre", "--contre"], ["a", "Abstention", "--abst"]];
    a = `<h3 style="color:${c}">Vote ouvert</h3>
      <p>Clôture le ${fmtD(d.phaseEnd)} (J-${daysLeft(d.phaseEnd)}). Tu peux changer d'avis jusqu'à la fin avec ton code de vote.${d.kind === "const" ? ` Une révision demande plus de ${n_(needMaj(d))} % de « pour ».` : ""}</p>
      ${!u ? loginBtn("Se connecter pour voter")
        : UI.receipt?.id === d.id ? receiptBox(UI.receipt)
        : d.voted ? `<p style="margin:0 0 10px"><strong>✓ Tu as voté.</strong> Ton choix n'est pas enregistré avec ton nom : pour le changer ou le retirer, saisis ton code de vote.</p>
          <form class="stack" data-form="revote">${codeField()}<div class="votebtns">${[...opts, ["x", "Retirer mon vote"]].map(([k, l]) => `<label class="optrow"><input type="radio" name="choice" value="${k}" required><span>${l}</span></label>`).join("")}</div>
          <div class="form-msg"></div><button class="btn primary" type="submit">Changer mon vote</button></form>`
        : `<div class="votebtns" role="group" aria-label="Ton vote">${opts.map(([k, l, cv]) => `<button class="vbtn" style="--c:var(${cv})" data-act="vote" data-v="${k}" ${needsVerify() ? "disabled" : ""}><span>${l}</span><span class="box"></span></button>`).join("")}</div>`}
      <p style="margin:12px 0 0;font-size:13px"><strong class="mono" style="color:var(--ink)">${fmtN(d.participation)}</strong> votants (${n_(pct(d.participation, d.electorate))} % des inscrits). Les résultats restent cachés jusqu'à la clôture pour ne pas influencer le vote.</p>`;
  } else {
    const r = d.result || {};
    if (r.outcome === "expired") a = `<div class="result-banner" style="--c:var(--abst)">Archivée</div><p>Le parrainage n'a pas atteint le seuil à temps (${fmtN(r.parrains)} sur ${fmtN(r.threshold)}). Chacun peut la reprendre sous forme de variante.</p>`;
    else {
      const v = r.votes, m = v.min || { p: 0, c: 0, a: 0 }, t = { p: v.maj.p + m.p, c: v.maj.c + m.c, a: v.maj.a + m.a }; t.all = t.p + t.c + t.a;
      const ok = r.outcome === "adopted";
      const row = (l, x, cv) => `<div class="res-row"><span>${l}</span><div class="bar" style="--c:var(${cv})"><span style="width:${pct(x, t.all)}%"></span></div><span class="pct">${n_(pct(x, t.all))} %</span></div>`;
      const grp = (g, label) => { const x = v[g], tt = x.p + x.c + x.a; return `<div><h4>${label} · ${fmtN(tt)}</h4><div class="stacked" role="img" aria-label="${label} : ${pct(x.p, tt)} % pour, ${pct(x.c, tt)} % contre, ${pct(x.a, tt)} % abstention"><span style="width:${pct(x.p, tt)}%;background:var(--pour)"></span><span style="width:${pct(x.c, tt)}%;background:var(--contre)"></span><span style="width:${pct(x.a, tt)}%;background:var(--abst)"></span></div><div class="mono" style="font-size:12px;margin-top:4px;color:var(--muted)">${n_(pct(x.p, tt))} / ${n_(pct(x.c, tt))} / ${n_(pct(x.a, tt))}</div></div>`; };
      const link = !ok ? "" : d.kind === "const" ? `<a class="btn small" href="#/constitution" style="margin-top:12px;text-decoration:none">Voir la Constitution</a>`
        : d.target ? `<a class="btn small" href="#/loi/${d.target.lawId}" style="margin-top:12px;text-decoration:none">Voir la loi</a>` : d.lawId ? `<a class="btn small" href="#/loi/${d.lawId}" style="margin-top:12px;text-decoration:none">Voir la loi</a>` : "";
      a = `<div class="result-banner" style="--c:${ok ? "var(--pour)" : "var(--contre)"}">${ok ? "Adoptée" : "Rejetée"}</div>
        ${row("Pour", t.p, "--pour")}${row("Contre", t.c, "--contre")}${row("Abstention", t.a, "--abst")}
        <p style="margin:10px 0 0;font-size:13px">${n_(r.pourPct)} % des voix exprimées pour (seuil : plus de ${n_(r.needMaj)} %). ${fmtN(t.all)} votants, soit ${n_(r.participationPct)} % des ${fmtN(r.electorate)} inscrits (minimum ${n_(r.needQuo)} %).</p>
        ${v.min ? `<div class="split">${grp("maj", "Majeurs")}${grp("min", "Mineurs")}</div>` : v.minorsMerged ? `<p class="muted" style="margin:10px 0 0;font-size:12px">Trop peu de votants mineurs pour publier leur décompte à part sans dévoiler leurs choix : ils sont comptés dans le total.</p>` : ""}
        <p style="margin:10px 0 0;font-size:12px">Pour / contre / abstention, en %.${r.applied ? " " + esc(r.applied) : ""}</p>${link}`;
    }
  }
  return `<div class="section">${timelineHtml(d)}</div>
    <div class="section action">${a}</div>
    <div class="section"><h2>Reprendre cette idée</h2><p class="muted" style="margin:0 0 10px;font-size:13px">Pas d'accord avec la direction prise ? Crée ta propre version, avec un lien vers celle-ci.</p><a class="btn small" href="#/variante/${d.id}" style="text-decoration:none;color:inherit">Créer une variante</a></div>
    ${me() && !d.isAuthor && !d.hidden ? `<div class="section"><h2>Un problème ?</h2><p class="muted" style="margin:0 0 10px;font-size:13px">Insulte, haine, spam, données personnelles… Un jury citoyen tiré au sort examinera le signalement.</p><button class="btn small ghost" data-act="report" data-type="proposal" data-id="${d.id}" ${d.myFlag ? "disabled" : ""}>${d.myFlag ? "Signalée" : "Signaler cette proposition"}</button></div>` : ""}
    ${isMod() ? `<div class="section"><h2>Administration</h2><p class="muted" style="margin:0 0 10px;font-size:13px">Seulement pour un contenu manifestement illégal. L'intervention est inscrite au journal public.</p>${d.hidden ? `<button class="btn small" data-act="mod-prop" data-v="restore">Rétablir la proposition</button>` : `<button class="btn small" data-act="urgent" data-type="proposal" data-id="${d.id}">Retirer en urgence</button>`}</div>` : ""}
    ${BOOT.demoMode && isAdmin() && d.phase !== "fin" ? `<div class="section demo-box"><h2 style="margin-bottom:8px">Démo · accélérer le temps</h2>
      <p class="muted" style="margin:0 0 10px;font-size:13px">Passe à l'étape suivante sans attendre. À la clôture, le résultat est calculé avec les vrais votes.</p>
      <button class="btn ink small" data-act="advance">Passer à : ${PHASES[PH[d.phase].i + 1].name} →</button></div>` : ""}`;
}

/* ---------- lois ---------- */
async function viewLaws() {
  const data = await api("GET", "/api/laws");
  VIEW = { name: "laws", data };
  return `<div class="page-head"><h1>Le recueil des lois</h1><p>Toutes les lois adoptées par vote. Chacune garde l'historique complet de ses versions, et peut être modifiée ou abrogée par une nouvelle proposition.</p></div>
  <div class="toolbar">
    <input class="search" id="lq" type="search" placeholder="Chercher une loi…" value="${esc(UI.lawQ)}" aria-label="Chercher une loi">
    <select id="lstatus" style="width:auto" aria-label="Statut"><option value="">Toutes</option><option value="vigueur" ${UI.lawStatus === "vigueur" ? "selected" : ""}>En vigueur</option><option value="abrogée" ${UI.lawStatus === "abrogée" ? "selected" : ""}>Abrogées</option></select>
  </div>
  <div class="list" id="lawlist">${lawCards()}</div>`;
}
function lawCards() {
  const qn = UI.lawQ.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const L = VIEW.data.items.filter(l => (!UI.lawStatus || l.status === UI.lawStatus) && (!qn || [l.title, l.versions[l.versions.length - 1].text, ...l.tags, ...l.themes].join(" ").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(qn)))
    .sort((a, b) => b.versions[b.versions.length - 1].date - a.versions[a.versions.length - 1].date);
  return L.map(l => { const lv = l.versions[l.versions.length - 1];
    return `<a class="card" href="#/loi/${l.id}" style="color:inherit;text-decoration:none">
      <span class="chips"><span class="status-chip ${l.status === "vigueur" ? "" : "off"}">${l.status === "vigueur" ? "En vigueur" : "Abrogée"}</span>${l.themes.map(t => `<span class="tag theme">${esc(t)}</span>`).join("")}${l.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join("")}</span>
      <span class="ttl">${esc(l.title)}</span><span class="sum">${esc(paras(lv.text)[0] || "")}</span>
      <span class="card-foot"><span>Version ${l.versions.length} · ${fmtD(lv.date)}</span><span class="mono">${l.pending ? `${plural(l.pending, "proposition")} en cours` : ""}</span></span></a>`; }).join("")
    || `<div class="empty">${VIEW.data.items.length ? "Aucune loi ne correspond." : "Aucune loi adoptée pour l'instant. La première viendra d'une proposition votée."}</div>`;
}
async function viewLaw(id) {
  const l = await api("GET", "/api/laws/" + encodeURIComponent(id));
  VIEW = { name: "law", data: l };
  const lt = l.versions[l.versions.length - 1].text;
  return `<a class="btn ghost small back" href="#/lois" style="text-decoration:none">← Le recueil des lois</a>
  <div class="cols"><div>
    <div class="chips"><span class="status-chip ${l.status === "vigueur" ? "" : "off"}">${l.status === "vigueur" ? "En vigueur" : "Abrogée"}</span>${l.themes.map(t => `<span class="tag theme">${esc(t)}</span>`).join("")}${l.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join("")}</div>
    <h1 class="dtitle" style="margin-bottom:18px">${esc(l.title)}</h1>
    <section class="section"><h2><span>Texte ${l.status === "vigueur" ? "en vigueur" : "au moment de l'abrogation"} · version ${l.versions.length}</span></h2>${numbered(lt, l.status !== "vigueur")}</section>
    <section class="section"><h2><span>Historique · ${plural(l.versions.length, "version")}</span></h2><ul class="hist">${l.versions.slice().reverse().map(v => {
      const key = `l:${l.id}:${v.n}`, open = UI.openVer === key, prev = l.versions[v.n - 2];
      return `<li><div class="row"><span class="v">v${v.n}</span><span>${esc(v.note)} <span class="muted">· ${fmtD(v.date)}</span>${v.via ? ` · <a href="#/p/${v.via}">voir la proposition</a>` : ""}</span>${prev && !v.abrog ? `<button class="btn small ghost" data-act="ver" data-k="${key}" aria-expanded="${open}">${open ? "Masquer" : "Voir les changements"}</button>` : "<span></span>"}</div>${open && prev ? `<div class="diff">${diffView(prev.text, v.text).html}</div>` : ""}</li>`;
    }).join("")}</ul></section></div>
  <aside class="side">
    <div class="section action"><h3>Faire évoluer</h3><p>Une loi adoptée n'est jamais gravée dans le marbre. N'importe qui peut proposer de la modifier ou de l'abroger, avec le même parcours.</p>
      ${l.status === "vigueur" ? `<div class="btnrow"><a class="btn primary" href="#/proposer/modif/${l.id}" style="text-decoration:none">Proposer une modification</a><a class="btn" href="#/proposer/abrog/${l.id}" style="text-decoration:none;color:inherit">Proposer l'abrogation</a></div>` : `<p style="margin:0">Cette loi est abrogée. Pour la rétablir, dépose une nouvelle loi.</p>`}</div>
    <div class="section"><h2>Propositions liées · ${l.related.length}</h2>${l.related.length ? `<ul class="mini">${l.related.map(p => `<li><a class="minilink" href="#/p/${p.id}"><span class="t">${esc(p.title)}</span> <span class="meta">${kindChip(p.kind)}${phaseChip(p)}</span></a></li>`).join("")}</ul>` : `<p class="muted" style="margin:0;font-size:14px">Aucune.</p>`}</div>
  </aside></div>`;
}

/* ---------- Constitution ---------- */
async function viewConst() {
  const data = await api("GET", "/api/proposals?kind=const&limit=200");
  VIEW = { name: "const", data };
  const cur = cstNow(), revs = data.items.filter(p => p.phase !== "fin");
  const hl = body => esc(body).replace(/(\d+(?:,\d+)?)( %| jours| parrains)/g, (m, a, b) => `<mark>${a}${b}</mark>`);
  return `<div class="page-head"><h1>Notre Constitution</h1><p>Les règles du jeu. Elles s'appliquent à toutes les propositions, et elles se changent comme le reste : par une proposition, un débat et un vote, avec une majorité renforcée.</p>
    <div class="chips"><span class="status-chip">Version ${cur.n}</span><span class="muted" style="font-size:14px">en vigueur depuis le ${fmtD(cur.date)}</span></div></div>
  <div class="cols">
    <div class="section">${constArticles(cur).map(a => `<div class="article"><h3>${esc(a.title)}</h3><p>${hl(a.body)}</p></div>`).join("")}</div>
    <aside class="side">
      <div class="section"><h2>Règles modifiables par vote</h2>
        <div class="tablewrap"><table class="ptable"><tbody>${PARAMS.map(p => `<tr><td>${esc(p.l)}</td><td class="v">${fmtParam(p.k, cur.params[p.k])}</td></tr>`).join("")}</tbody></table></div>
        <a class="btn primary" href="#/proposer/const" style="margin-top:14px;width:100%;text-decoration:none">Proposer une révision</a></div>
      <div class="section"><h2>Révisions en cours · ${revs.length}</h2>${revs.length ? `<ul class="mini">${revs.map(p => `<li><a class="minilink" href="#/p/${p.id}"><span class="t">${esc(p.title)}</span> <span class="meta">${phaseChip(p)} @${esc(p.author.pseudo)}</span></a></li>`).join("")}</ul>` : `<p class="muted" style="margin:0;font-size:14px">Aucune.</p>`}</div>
      <div class="section"><h2>Historique · ${plural(BOOT.constitution.length, "version")}</h2><ul class="hist">${BOOT.constitution.slice().reverse().map(v => {
        const key = `c:${v.n}`, open = UI.openVer === key, prev = BOOT.constitution[v.n - 2];
        const body = open && prev ? (paramChanges(prev, v).length ? paramTable(paramChanges(prev, v)) : "") + artDiffs(constDiffs(prev, v)) : "";
        return `<li><div class="row"><span class="v">v${v.n}</span><span>${esc(v.note)} <span class="muted">· ${fmtD(v.date)}</span>${v.via ? ` · <a href="#/p/${v.via}">proposition</a>` : ""}</span>${prev ? `<button class="btn small ghost" data-act="ver" data-k="${key}" aria-expanded="${open}">${open ? "Masquer" : "Diff"}</button>` : "<span></span>"}</div>${body}</li>`;
      }).join("")}</ul></div>
    </aside></div>`;
}
function cstEditor(base, target, pfx) {
  return `<div class="fieldset"><div class="lg">Règles chiffrées</div>
    <div class="tablewrap"><table class="ptable"><thead><tr><th>Règle</th><th>En vigueur</th><th>Proposé</th></tr></thead><tbody>
    ${PARAMS.map(p => `<tr class="${target.params[p.k] !== base.params[p.k] ? "changed" : ""}"><td><label for="${pfx}-${p.k}">${esc(p.l)}</label></td><td class="v">${fmtParam(p.k, base.params[p.k])}</td><td style="white-space:nowrap"><input type="number" class="cst-in" id="${pfx}-${p.k}" value="${target.params[p.k]}" min="${p.min}" max="${p.max}" step="${p.step || 1}" required> <span class="muted" style="font-size:12px">${esc(p.u)}</span></td></tr>`).join("")}
    </tbody></table></div></div>
    <div class="fieldset"><div class="lg">Textes de principe</div>
    ${FREE_KEYS.map(([k, l]) => `<label class="f">${esc(l)}<textarea class="cst-in" id="${pfx}-free-${k}" rows="3" required>${esc(target.free[k])}</textarea></label>`).join("")}</div>
    <div class="fieldset"><div class="lg">Aperçu des changements</div><div id="${pfx}-preview">${cstPreview(base, target)}</div></div>`;
}
function readCst(pfx) {
  const raw = { params: {}, free: {} };
  PARAMS.forEach(p => raw.params[p.k] = $(`#${pfx}-${p.k}`).value);
  FREE_KEYS.forEach(([k]) => raw.free[k] = $(`#${pfx}-free-${k}`).value);
  return sanitizeCst(raw);
}
const cstPreview = (base, target) => { const ch = constDiffs(base, target); return ch.length ? artDiffs(ch) : `<p class="muted" style="margin:0;font-size:14px">Change une valeur ou un texte : les articles modifiés apparaissent ici.</p>`; };

/* ---------- nouvelle proposition ---------- */
function kindTiles() {
  return `<div class="kinds" role="group" aria-label="Type de proposition">${Object.entries(KINDS).map(([k, v]) => `<button class="kindtile" data-act="newkind" data-k="${k}" aria-pressed="${UI.newKind === k}"><span class="t">${v.label}</span><span class="d">${v.desc}</span></button>`).join("")}</div>`;
}
async function viewNew(arg1, arg2) {
  VIEW = { name: "new", data: null };
  if (!me()) { UI.after = location.hash; return `<div class="page-head"><h1>Proposer</h1><p>Il faut un compte pour déposer une proposition : un e-mail, un pseudo et un mot de passe suffisent.</p></div><div class="btnrow"><a class="btn primary" href="#/inscription" style="text-decoration:none">Créer un compte</a><a class="btn" href="#/connexion" style="text-decoration:none;color:inherit">Se connecter</a></div>`; }
  if (arg1 && KINDS[arg1] && !UI.prefill?.fromRoute) { UI.newKind = arg1; UI.prefill = { lawId: arg2 || null, fromRoute: true }; }
  const [laws, facets] = await Promise.all([api("GET", "/api/laws"), api("GET", "/api/proposals?limit=1")]);
  VIEW.data = { laws: laws.items, tags: facets.facets.tags };
  return newHtml();
}
function newHtml() {
  const k = UI.newKind, pf = UI.prefill || {}, r = cstNow().params;
  const lawsV = VIEW.data.laws.filter(l => l.status === "vigueur");
  const law = (k === "modif" || k === "abrog") ? (lawsV.find(l => l.id === pf.lawId) || lawsV[0]) : null;
  const head = `<div class="page-head"><h1>Proposer</h1><p>Ta proposition entre en phase « Projet ». Pendant la durée que tu choisis, tout le monde peut la commenter et l'améliorer. Tu restes le porteur : c'est toi qui décides de ce que tu intègres.</p></div>
    ${needsVerify() ? `<div class="notice warn">Confirme d'abord ton adresse e-mail pour pouvoir déposer.</div>` : ""}${kindTiles()}`;
  const lawText = l => l.versions[l.versions.length - 1].text;
  let specific = "";
  if (k === "loi") specific = `<label class="f">Texte de la proposition <small>Écris-la comme un article de loi : un paragraphe par idée, séparés par une ligne vide. Chaque paragraphe sera numéroté (§1, §2…) pour les amendements.</small><textarea id="p-text" required rows="9">${esc(pf.text || "")}</textarea></label>`;
  if (k === "modif" || k === "abrog") {
    if (!law) return head + `<div class="empty">Aucune loi en vigueur pour l'instant. Une loi naît d'une proposition « Nouvelle loi » adoptée par vote.</div>`;
    specific = `<label class="f">Loi visée<select id="p-law">${lawsV.map(l => `<option value="${l.id}" ${l.id === law.id ? "selected" : ""}>${esc(l.title)} (v${l.versions.length})</option>`).join("")}</select></label>`;
    if (k === "modif") {
      const start = pf.text && pf.lawId === law.id ? pf.text : lawText(law);
      specific += `<label class="f">Nouveau texte de la loi <small>Pré-rempli avec la version en vigueur : modifie-le directement. Les différences s'affichent en dessous.</small><textarea id="p-text" required rows="10">${esc(start)}</textarea></label>
        <div class="fieldset"><div class="lg">Aperçu des changements</div><div class="diff" id="p-diff">${diffView(lawText(law), start).html}</div></div>`;
    } else specific += `<div class="fieldset"><div class="lg">Texte qui serait supprimé</div>${numbered(lawText(law), true)}</div>
      <label class="f">Exposé des motifs <small>Pourquoi cette loi doit disparaître.</small><textarea id="p-text" required rows="6">${esc(pf.text || "")}</textarea></label>`;
  }
  if (k === "const") {
    const target = pf.cst ? clone(pf.cst) : clone({ params: cstNow().params, free: cstNow().free });
    specific = cstEditor(cstNow(), target, "c") + `<label class="f">Exposé des motifs <small>Pourquoi changer ces règles.</small><textarea id="p-text" required rows="5">${esc(pf.text || "")}</textarea></label>`;
  }
  const dflTitle = pf.title || (k === "modif" && law ? `Modifier : ${law.title}` : k === "abrog" && law ? `Abroger : ${law.title}` : "");
  const themesSel = pf.themes || (law ? law.themes : []);
  return head + `
  <form class="stack" data-form="new" style="max-width:800px">
    ${pf.forkOf ? `<div class="notice">Variante de « ${esc(pf.forkTitle || "")} ». Un lien vers l'original sera affiché des deux côtés.</div>` : ""}
    <label class="f">Titre <small>Une phrase claire qui dit ce qui change.</small><input type="text" id="p-title" required minlength="5" maxlength="120" value="${esc(dflTitle)}" placeholder="Ex. : Rendre le permis de conduire gratuit pour les 17-25 ans"></label>
    <label class="f">Résumé <small>280 caractères max. C'est ce qu'on lit en premier.</small><textarea id="p-summary" required minlength="10" maxlength="280" rows="2">${esc(pf.summary || "")}</textarea></label>
    ${specific}
    ${k === "const" ? "" : `<div class="f">Thèmes<div class="checks">${THEMES.filter(t => t !== "Constitution").map(t => `<label><input type="checkbox" name="theme" value="${t}" ${themesSel.includes(t) ? "checked" : ""}> ${t}</label>`).join("")}</div></div>`}
    <label class="f">Tags <small>6 maximum, séparés par des virgules ou des espaces. Réutilise les tags existants pour qu'on retrouve ta proposition.</small><input type="text" id="p-tags" list="taglist" value="${esc((pf.tags || (law ? law.tags : [])).join(", "))}" placeholder="transparence, élus"></label>
    <datalist id="taglist">${VIEW.data.tags.map(([t]) => `<option value="${esc(t)}">`).join("")}</datalist>
    <div class="checks"><label><input type="checkbox" id="p-2027" ${pf.is2027 ? "checked" : ""}> Ajouter au cahier citoyen Présidentielle 2027</label></div>
    <div class="row2">
      <label class="f">Durée de la phase Projet <small>Entre ${r.projetMin} et ${r.projetMax} jours (Constitution, art. 2).</small><select id="p-pdays">${durOptions(r.projetMin, r.projetMax, 15, 30)}</select></label>
      <label class="f">Durée de la délibération <small>Entre ${r.delibMin} et ${r.delibMax} jours (art. 4).</small><select id="p-ddays">${durOptions(r.delibMin, r.delibMax, 30, r.delibMin)}</select></label>
    </div>
    <label class="f">Liens et sources <small>Un lien par ligne (https://…). 10 maximum.</small><textarea id="p-links" rows="3" placeholder="https://">${esc(pf.links || "")}</textarea></label>
    <label class="f">Fichiers <small>PDF, images, tableurs, documents (10 Mo max par fichier, 10 fichiers).</small><input type="file" id="p-files" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.csv,.txt,.md,.odt,.ods,.odp,.docx,.xlsx,.pptx"></label>
    <div class="form-msg"></div>
    <div class="btnrow"><button class="btn primary" type="submit" ${needsVerify() ? "disabled" : ""}>Déposer la proposition</button><a class="btn ghost" href="#/" style="text-decoration:none">Annuler</a></div>
  </form>`;
}
function captureNew() {
  const g = id => { const e = $(id); return e ? e.value : undefined; }, pf = UI.prefill || {};
  UI.prefill = Object.assign({}, pf, {
    title: g("#p-title") ?? pf.title, summary: g("#p-summary") ?? pf.summary,
    tags: $("#p-tags") ? parseTags($("#p-tags").value) : pf.tags, links: g("#p-links") ?? pf.links,
    is2027: $("#p-2027") ? $("#p-2027").checked : pf.is2027,
    themes: document.querySelector("input[name=theme]") ? [...document.querySelectorAll("input[name=theme]:checked")].map(x => x.value) : pf.themes
  });
}
async function viewFork(id) {
  const d = await api("GET", "/api/proposals/" + encodeURIComponent(id));
  UI.newKind = d.kind;
  UI.prefill = { fromRoute: true, forkOf: d.id, forkTitle: d.title, title: "Variante : " + d.title.slice(0, 100), summary: d.summary, text: curV(d).text,
    themes: d.themes.filter(t => t !== "Constitution"), tags: d.tags, is2027: d.is2027, lawId: d.target ? d.target.lawId : null,
    cst: d.kind === "const" ? (d.merged || curV(d).cst) : null, links: d.links.map(l => l.url).join("\n") };
  return viewNew();
}

/* ---------- comptes ---------- */
// Le défi anti-robot se résout en arrière-plan pendant que la personne remplit le formulaire.
const startAntibot = () => { UI.pow = solveAntibot(); UI.pow.catch(() => {}); };
async function takeAntibot(box) {
  if (!UI.pow) startAntibot();
  const slow = setTimeout(() => { if (box) box.innerHTML = `<div class="notice">Vérification anti-robot…</div>`; }, 400);
  try { return await UI.pow; } finally { clearTimeout(slow); if (box) box.innerHTML = ""; startAntibot(); }
}
function viewLogin() {
  VIEW = { name: "login", data: null };
  startAntibot();
  return `<div class="auth-wrap"><div class="page-head" style="text-align:left"><h1>Se connecter</h1></div>
  <div class="section"><form class="stack" data-form="login">
    <label class="f">E-mail<input type="email" id="l-email" required autocomplete="email"></label>
    <label class="f">Mot de passe<input type="password" id="l-pass" required autocomplete="current-password"></label>
    <div class="hp" aria-hidden="true"><label>Ne pas remplir<input type="text" name="nepasremplir" tabindex="-1" autocomplete="off"></label></div>
    <div class="form-msg"></div>
    <button class="btn primary" type="submit">Se connecter</button>
    <p class="muted" style="margin:0;font-size:14px">Pas encore de compte ? <a href="#/inscription">S'inscrire</a>${BOOT.mailEnabled ? ` · <a href="#/reinitialiser">Mot de passe oublié</a>` : ""}</p>
  </form></div></div>`;
}
function viewRegister() {
  VIEW = { name: "register", data: null };
  startAntibot();
  return `<div class="auth-wrap"><div class="page-head"><h1>Rejoindre</h1><p>Un e-mail, un pseudo et un mot de passe. Ton pseudo est public, ton e-mail ne l'est jamais.</p></div>
  <div class="section"><form class="stack" data-form="register">
    <label class="f">E-mail<input type="email" id="r-email" required autocomplete="email" placeholder="prenom@exemple.fr"></label>
    <label class="f">Pseudo <small>3 à 20 caractères : lettres sans accent, chiffres, point, tiret, tiret bas.</small><input type="text" id="r-pseudo" required minlength="3" maxlength="20" pattern="[A-Za-z0-9._\\-]{3,20}" autocomplete="nickname"></label>
    <label class="f">Mot de passe <small>8 caractères minimum.</small><input type="password" id="r-pass" required minlength="8" autocomplete="new-password"></label>
    <div class="hp" aria-hidden="true"><label>Ne pas remplir<input type="text" name="nepasremplir" tabindex="-1" autocomplete="off"></label></div>
    <div class="f">Tu as…<div class="seg"><label><input type="radio" name="age" value="maj" checked> 18 ans ou plus</label><label><input type="radio" name="age" value="min"> Moins de 18 ans</label></div><small>Tout le monde vote. Ça sert seulement à afficher aussi les résultats par âge. Si tu as moins de 15 ans, inscris-toi avec l'accord d'un de tes parents.</small></div>
    <label class="consent"><input type="checkbox" id="r-consent" required><span>J'accepte la <a href="#/constitution" target="_blank">Constitution</a> et sa charte du débat. Je consens à ce que mes propositions, parrainages et votes, qui peuvent révéler mes opinions politiques, soient traités pour faire fonctionner mesvotes (<a href="#/mentions-legales" target="_blank">confidentialité</a>). Je peux retirer ce consentement en supprimant mon compte.</span></label>
    <div class="form-msg"></div>
    <button class="btn primary" type="submit">Créer mon compte</button>
  </form></div></div>`;
}
function viewReset(params) {
  VIEW = { name: "reset", data: null };
  const t = params.get("t");
  if (!t) startAntibot();
  return `<div class="auth-wrap"><div class="page-head"><h1>Mot de passe</h1></div><div class="section">
  ${t ? `<form class="stack" data-form="reset" data-t="${esc(t)}"><label class="f">Nouveau mot de passe<input type="password" id="np" required minlength="8" autocomplete="new-password"></label><div class="form-msg"></div><button class="btn primary" type="submit">Enregistrer</button></form>`
      : `<form class="stack" data-form="forgot"><label class="f">Ton e-mail<input type="email" id="fe" required autocomplete="email"></label><div class="hp" aria-hidden="true"><label>Ne pas remplir<input type="text" name="nepasremplir" tabindex="-1" autocomplete="off"></label></div><div class="form-msg"></div><button class="btn primary" type="submit">Recevoir un lien</button></form>`}
  </div></div>`;
}
async function viewAccount(params) {
  VIEW = { name: "account", data: null };
  if (!me()) return viewLogin();
  const u = me(), ok = params.get("ok");
  const notifs = await api("GET", "/api/notifications").catch(() => ({ items: [] }));
  if (notifs.items.some(n => !n.read)) api("POST", "/api/notifications/read").then(() => { me().unread = 0; renderHeader(); }).catch(() => {});
  return `<div class="page-head"><h1>@${esc(u.pseudo)}</h1><p>${esc(u.email)} · ${u.minor ? "moins de 18 ans" : "18 ans ou plus"} · ${{ user: "membre", moderator: "modération", admin: "administration" }[u.role]}</p></div>
  ${ok === "verifie" ? `<div class="notice ok">Adresse confirmée. Tu peux maintenant proposer, parrainer et voter.</div>` : ok === "lien-expire" ? `<div class="notice warn">Ce lien a expiré ou a déjà servi. Demande-en un nouveau ci-dessous.</div>` : ""}
  <div class="section"><h2>Notifications</h2>${notifs.items.length ? `<ul class="journal">${notifs.items.map(n => `<li class="${n.read ? "" : "unread"}"><span class="dt">${fmtDs(n.date)}</span><span>${n.link ? `<a href="${esc(n.link)}">${esc(n.text)}</a>` : esc(n.text)}</span></li>`).join("")}</ul>` : `<p class="muted" style="margin:0">Rien pour l'instant.</p>`}</div>
  <div class="grid2">
    <div class="section"><h2>Mon activité</h2><div class="btnrow"><a class="btn" href="#/u/${encodeURIComponent(u.pseudo)}" style="text-decoration:none;color:inherit">Mon profil public</a><button class="btn" data-act="mine-list">Voir mes propositions</button><a class="btn primary" href="#/proposer" style="text-decoration:none">Proposer</a></div>
      ${needsVerify() ? `<p style="margin:14px 0 8px;font-size:14px">Ton adresse n'est pas encore confirmée.</p><button class="btn small" data-act="resend">Renvoyer le lien de confirmation</button>` : ""}</div>
    <div class="section"><h2>Changer de mot de passe</h2><form class="stack" data-form="password">
      <label class="f">Mot de passe actuel<input type="password" id="cp" required autocomplete="current-password"></label>
      <label class="f">Nouveau mot de passe<input type="password" id="cn" required minlength="8" autocomplete="new-password"></label>
      <div class="form-msg"></div><button class="btn small" type="submit">Enregistrer</button></form></div>
  </div>
  <div class="grid2">
    <div class="section"><h2>Session</h2><button class="btn" data-act="logout">Se déconnecter</button></div>
    <div class="section"><h2>Supprimer mon compte</h2><p class="muted" style="margin:0 0 10px;font-size:14px">Ton e-mail est effacé et ton pseudo remplacé. Tes contributions restent dans l'historique public, sans ton nom. C'est définitif.</p>
      <form class="stack" data-form="delete"><label class="f">Confirme avec ton mot de passe<input type="password" id="dp" required autocomplete="current-password"></label><div class="form-msg"></div><button class="btn small" type="submit">Supprimer définitivement</button></form></div>
  </div>`;
}

/* ---------- code de vote ---------- */
// Le code n'est gardé qu'en mémoire, le temps de l'afficher : rien ne reste sur l'appareil,
// ce qui compte sur une tablette partagée (en mairie, par exemple).
const receiptBox = rc => `<div class="notice ok" role="status"><strong>A voté.</strong> Ton code de vote :
  <div class="mono" style="font-size:18px;letter-spacing:.04em;margin:8px 0;color:var(--ink);user-select:all">${esc(rc.code)}</div>
  <p style="margin:0 0 10px;font-size:13px">Note-le ou prends-le en photo : c'est le seul moyen de changer ton vote jusqu'à la clôture. Il ne sera plus jamais affiché. Le site sait que tu as voté, pas ce que tu as voté.</p>
  <button class="btn small" data-act="receipt-done">C'est noté</button></div>`;
const codeField = () => `<label class="f">Code de vote<input id="rv-code" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE-FGHJK-MNPQR-STUVW"></label>`;

/* ---------- modération et administration ---------- */
async function viewMod() {
  const data = await api("GET", "/api/moderation"); VIEW = { name: "mod", data };
  const r = data.rules;
  const caseRow = c => `<a class="minilink" href="#/affaire/${c.id}"><span class="t">${TYPE_LABEL[c.targetType]} · affaire ${esc(c.short)}${c.round === 2 ? " (appel)" : ""}</span>
    <span class="meta">${c.status === "open" ? `<span class="pill">à juger avant le ${fmtD(c.deadline)}</span>` : `<span class="pill">${esc(actionLabel(c.targetType, c.decision))}</span>`}${c.reasons[0] ? `<span>${esc(REASON_LABEL[c.reasons[0][0]])}</span>` : ""}${c.voted !== undefined ? `<span>${c.voted ? "✓ tu as voté" : "<strong>ton vote est attendu</strong>"}</span>` : ""}</span></a>`;
  return `<div class="page-head"><h1>Modération citoyenne</h1><p>Ici, ce sont les inscrits qui modèrent. Dès ${r.modReports} signalement${r.modReports > 1 ? "s" : ""}, un jury de ${r.modJury} inscrits est tiré au sort. Il a ${r.modHours} heures pour choisir une mesure ; la mesure retenue est la médiane des votes. L'auteur peut faire appel une fois devant un jury de ${r.modJury * 2 + 1} inscrits.</p></div>
  ${me() ? `<div class="grid2">
    <div class="section"><h2>À juger · ${data.duties.length}</h2>${data.duties.length ? `<ul class="mini">${data.duties.map(c => `<li>${caseRow(c)}</li>`).join("")}</ul>` : `<p class="muted" style="margin:0;font-size:14px">Aucune affaire pour toi en ce moment. Quand tu es tiré(e) au sort, tu es prévenu(e) ici et dans tes notifications.</p>`}</div>
    <div class="section"><h2>Me concernant · ${data.mine.length}</h2>${data.mine.length ? `<ul class="mini">${data.mine.map(c => `<li>${caseRow(c)}</li>`).join("")}</ul>` : `<p class="muted" style="margin:0;font-size:14px">Aucun signalement ne te concerne.</p>`}</div>
  </div>` : `<div class="notice"><a href="#/inscription">Inscris-toi</a> pour pouvoir signaler et être tiré(e) au sort comme juré.</div>`}
  ${data.open ? `<div class="section"><h2>Affaires en cours · ${data.open.length} <span class="muted">(visible par l'administration)</span></h2>${data.open.map(c => `<div class="queue-item">
      <div class="meta"><strong style="color:var(--ink)">${TYPE_LABEL[c.targetType]} de ${userLink(c.snapshot.author)}</strong><span>· affaire <a href="#/affaire/${c.id}">${esc(c.short)}</a></span><span>· ${c.votes}/${c.jurySize} votes</span><span>· échéance ${fmtD(c.deadline)}</span></div>
      <blockquote>${esc(c.snapshot.title || c.snapshot.text || ("Compte @" + c.snapshot.author))}</blockquote>
      ${c.targetType !== "user" ? `<div class="btnrow"><button class="btn small" data-act="urgent" data-type="${c.targetType}" data-id="${esc(c.targetId)}">Retirer en urgence (contenu illégal)</button></div>` : ""}</div>`).join("") || `<p class="muted" style="margin:0">Aucune.</p>`}</div>` : ""}
  <div class="section"><h2>Contenus masqués · ${data.masked.length}</h2>
    <p class="muted" style="margin:0 0 10px;font-size:13px">Masquer peut se faire seul, en urgence. Supprimer définitivement, non : un contenu masqué disparaît seulement quand ${r.modDelVotes} inscrits votent pour sa suppression. Pas pendant l'examen d'un jury, et l'auteur ne vote pas.</p>
    ${data.masked.length ? `<ul class="mini">${data.masked.map(m => `<li><div class="row"><span class="t">${esc(m.label)} <span class="muted">· ${m.removed ? "retiré" : "masqué"} le ${fmtD(m.date)}</span></span>${delVoteBtn(m.type, m.id, m, m.own)}</div></li>`).join("")}</ul>` : `<p class="muted" style="margin:0">Aucun contenu masqué en attente.</p>`}</div>
  <div class="section"><h2>Décisions récentes · ${data.closed.length}</h2>${data.closed.length ? `<div class="tablewrap"><table class="admin-table"><thead><tr><th>Date</th><th>Affaire</th><th>Motif principal</th><th>Décision</th><th>Votes</th></tr></thead><tbody>
    ${data.closed.map(c => `<tr><td class="mono">${fmtDs(c.closedAt)}</td><td><a href="#/affaire/${c.id}">${TYPE_LABEL[c.targetType]} · ${esc(c.short)}</a>${c.round === 2 ? " (appel)" : ""}</td><td>${c.reasons[0] ? esc(REASON_LABEL[c.reasons[0][0]]) : "—"}</td><td>${esc(actionLabel(c.targetType, c.decision))}${c.note ? ` <span class="muted">· ${esc(c.note)}</span>` : ""}</td><td class="mono">${c.votes}/${c.jurySize}</td></tr>`).join("")}
  </tbody></table></div>` : `<p class="muted" style="margin:0">Aucune décision pour l'instant.</p>`}</div>`;
}

async function viewCase(id) {
  const c = await api("GET", "/api/cases/" + encodeURIComponent(id)); VIEW = { name: "case", data: c };
  const s = c.snapshot;
  let content = "";
  if (s) {
    if (s.type === "note") content = `<p class="muted" style="margin:0 0 8px;font-size:14px">${s.noteType === "amend" ? "Amendement" : s.noteType === "source" ? "Source" : "Commentaire"} de ${userLink(s.author)} sur <a href="#/p/${s.proposalId}">${esc(s.proposalTitle)}</a> · ${fmtD(s.date)}</p>
      ${s.noteType === "amend" ? `<div class="diff" style="margin-bottom:8px">${diffView(s.base || "", s.proposed || "").html}</div>` : ""}<blockquote class="quote">${esc(s.text)}</blockquote>`;
    else if (s.type === "proposal") content = `<p class="muted" style="margin:0 0 8px;font-size:14px">Proposition de ${userLink(s.author)} · <a href="#/p/${s.proposalId}">ouvrir</a></p><h3 style="margin:0 0 6px;font-size:20px">${esc(s.title)}</h3><p style="margin:0 0 12px">${esc(s.summary)}</p>${numbered(s.text)}`;
    else content = `<p style="margin:0 0 10px">Compte ${userLink(s.author)}, inscrit le ${fmtD(s.memberSince)}. Dernières contributions :</p>${s.recent.length ? s.recent.map(x => `<div class="queue-item"><div class="meta">sur <a href="#/p/${x.proposalId}">${esc(x.proposalTitle)}</a> · ${fmtD(x.date)}</div><blockquote>${esc(x.text)}</blockquote></div>`).join("") : `<p class="muted">Aucune contribution visible.</p>`}`;
  }
  const tallyBars = (t, type) => { const tot = Object.values(t || {}).reduce((a, b) => a + b, 0) || 1; return actionsFor(type).map(a => `<div class="res-row"><span>${esc(a.label)}</span><div class="bar" style="--c:var(--ink)"><span style="width:${(t?.[a.id] || 0) / tot * 100}%"></span></div><span class="pct">${t?.[a.id] || 0}</span></div>`).join(""); };
  const open = c.status === "open";
  return `<a class="btn ghost small back" href="#/moderation" style="text-decoration:none">← Modération citoyenne</a>
  <div class="page-head"><h1>Affaire ${esc(c.short)}</h1><p>${TYPE_LABEL[c.targetType]} signalé${c.targetType === "user" ? "" : "e"} · ${c.round === 2 ? "appel devant un jury élargi" : "premier examen"} · ${open ? `jury de ${c.jurySize} inscrits, ${c.votes} vote${c.votes > 1 ? "s" : ""}, échéance le ${fmtD(c.deadline)}` : `close le ${fmtD(c.closedAt)}`}</p>
    <div class="chips">${c.reasons.map(([r, n]) => `<span class="tag">${esc(REASON_LABEL[r])} · ${n}</span>`).join("")}</div></div>
  <div class="cols"><div>
    ${s ? `<section class="section"><h2>Ce qui est signalé</h2>${content}</section>` : `<div class="notice">Le contenu de l'affaire n'est visible que par les jurés, la personne concernée et l'administration.</div>`}
    ${c.comments?.length ? `<section class="section"><h2>Commentaires des signalements (anonymes)</h2><ul class="journal">${c.comments.map(x => `<li><span class="dt">${esc(REASON_LABEL[x.reason])}</span><span>${esc(x.comment)}</span></li>`).join("")}</ul></section>` : ""}
    ${c.firstDecision ? `<section class="section"><h2>Première décision (contestée)</h2><p style="margin:0">« ${esc(actionLabel(c.targetType, c.firstDecision))} »</p></section>` : ""}
    ${!open ? `<section class="section"><h2>Décision du jury</h2><div class="result-banner" style="--c:${c.decision === "keep" ? "var(--pour)" : "var(--ink)"}">${esc(actionLabel(c.targetType, c.decision))}</div>${c.note ? `<p class="muted" style="margin:0 0 10px">${esc(c.note)}</p>` : ""}${tallyBars(c.tally, c.targetType)}
      <p class="muted" style="margin:10px 0 0;font-size:13px">${c.votes} juré${c.votes > 1 ? "s" : ""} sur ${c.jurySize} ont voté. La mesure retenue est la médiane : la plus sévère qu'au moins la moitié des jurés juge justifiée.</p></section>` : ""}
    ${c.juryComments?.length ? `<section class="section"><h2>Remarques des jurés (anonymes)</h2><ul class="journal">${c.juryComments.map(x => `<li><span class="dt">${esc(actionLabel(c.targetType, x.vote))}</span><span>${esc(x.comment)}</span></li>`).join("")}</ul></section>` : ""}
  </div>
  <aside class="side">
    ${c.isJuror && open ? `<div class="section action"><h3>Ton vote</h3>${UI.receipt?.id === c.id ? receiptBox(UI.receipt) : `<p>${c.voted ? "<strong>✓ Tu as voté.</strong> Ta mesure n'est pas enregistrée avec ton nom : pour la changer, saisis ton code de vote." : "Choisis la mesure qui te semble juste. Ton vote reste anonyme : tu recevras un code pour le changer jusqu'à la clôture."}</p>
      <form class="stack" data-form="jury">${c.voted ? codeField() : ""}<div class="votebtns">${c.actions.map(a => `<label class="optrow"><input type="radio" name="action" value="${a.id}" required><span><strong>${esc(a.label)}</strong><small>${esc(a.desc)}</small></span></label>`).join("")}</div>
      <label class="f">Remarque pour les autres jurés <small>Facultatif, anonyme, visible après la clôture.</small><textarea id="j-comment" rows="2" maxlength="500"></textarea></label>
      <div class="form-msg"></div><button class="btn primary" type="submit">${c.voted ? "Changer mon vote" : "Voter"}</button></form>`}</div>` : ""}
    ${c.isJuror && !open ? `<div class="section"><p style="margin:0">Merci d'avoir participé à ce jury.</p></div>` : ""}
    ${c.isTarget ? `<div class="section action"><h3>Te concernant</h3><p>${open ? "Un jury citoyen tiré au sort examine ce signalement. Tu seras prévenu(e) de la décision." : c.decision === "keep" ? "Aucune mesure n'a été prise." : c.round === 2 ? "Cette décision d'appel est définitive." : "Tu peux contester cette décision une fois, dans les 7 jours, devant un jury élargi qui n'a jamais vu l'affaire."}</p>
      ${c.canAppeal ? `<button class="btn primary" data-act="appeal" data-id="${c.id}">Faire appel</button>` : ""}${c.appealCase ? `<a class="btn" href="#/affaire/${c.appealCase}" style="text-decoration:none;color:inherit">Voir l'appel</a>` : ""}</div>` : ""}
    <div class="section"><h2>Comment ça marche</h2><p class="muted" style="margin:0;font-size:13px">Les jurés sont tirés au sort parmi les inscrits, hors la personne concernée et les auteurs des signalements. Si moins de la moitié vote, des remplaçants sont tirés une fois ; ensuite, le doute profite à l'auteur.</p></div>
  </aside></div>`;
}

async function viewProfile(pseudo) {
  const u = await api("GET", "/api/users/" + encodeURIComponent(pseudo)); VIEW = { name: "profile", data: u };
  return `<div class="page-head"><div class="chips">${avatar(u.pseudo)}${u.minor ? '<span class="minor">-18</span>' : ""}${u.closed ? '<span class="pill">compte fermé</span>' : ""}${u.suspended ? '<span class="pill warn">suspendu</span>' : ""}${u.fictional ? '<span class="pill">compte d\'exemple</span>' : ""}</div>
    <h1 style="margin-top:12px">@${esc(u.pseudo)}</h1><p>Inscrit le ${fmtD(u.memberSince)} · ${plural(u.proposals.length, "proposition")} · ${plural(u.notesCount, "contribution")}</p></div>
  <div class="cols"><div class="section"><h2>Propositions portées</h2>${u.proposals.length ? `<ul class="mini">${u.proposals.map(p => `<li><a class="minilink" href="#/p/${p.id}"><span class="t">${esc(p.title)}</span> <span class="meta">${kindChip(p.kind)}${phaseChip(p)}</span></a></li>`).join("")}</ul>` : `<p class="muted" style="margin:0">Aucune pour l'instant.</p>`}</div>
  <aside class="side">${me() && !u.isMe && !u.closed ? `<div class="section"><h2>Un problème ?</h2><p class="muted" style="margin:0 0 10px;font-size:13px">Harcèlement, comportement répété… Signale le compte : un jury citoyen examinera son activité.</p><button class="btn small ghost" data-act="report" data-type="user" data-id="${esc(u.pseudo)}" ${u.myFlag ? "disabled" : ""}>${u.myFlag ? "Compte signalé" : "Signaler ce compte"}</button></div>` : ""}
    ${u.isMe ? `<div class="section"><a class="btn" href="#/compte" style="text-decoration:none;color:inherit">Mon compte</a></div>` : ""}</aside></div>`;
}

function openReport(type, id) {
  const r = cstNow().params;
  $("#modal-root").innerHTML = `<div class="overlay" data-act="close-modal"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="rp-t">
    <h2 id="rp-t">Signaler</h2><p>${TYPE_LABEL[type]} · dès ${r.modReports} signalement${r.modReports > 1 ? "s" : ""}, un jury de ${r.modJury} inscrits tirés au sort décidera de la mesure à prendre. On juge la forme, jamais l'opinion.</p>
    <form class="stack" data-form="report" data-type="${type}" data-id="${esc(id)}">
      <div class="reasons">${REPORT_REASONS.map(([k, l], i) => `<label class="optrow"><input type="radio" name="reason" value="${k}" ${i === 0 ? "" : ""} required><span>${esc(l)}</span></label>`).join("")}</div>
      <label class="f">Précisions pour le jury <small>Facultatif, anonyme. 500 caractères.</small><textarea id="rp-comment" rows="2" maxlength="500"></textarea></label>
      <div class="form-msg"></div>
      <div class="btnrow"><button class="btn primary" type="submit">Envoyer le signalement</button><button class="btn ghost" type="button" data-act="close-modal-btn">Annuler</button></div>
    </form></div></div>`;
}
const closeModal = () => { $("#modal-root").innerHTML = ""; };

async function viewAdmin(params) {
  if (!isAdmin()) return `<div class="empty">Réservé aux administrateurs.</div>`;
  const qs = params.get("q") || "";
  const data = await api("GET", "/api/admin/users?q=" + encodeURIComponent(qs)); VIEW = { name: "admin", data };
  return `<div class="page-head"><h1>Administration</h1><p>Comptes inscrits. La modération courante est faite par des jurys citoyens ; ici, seulement les rôles et les interventions d'urgence (inscrites au journal public). ${fmtN(BOOT.electorate)} inscrits comptent dans le corps électoral.</p></div>
  <form class="toolbar" data-form="usersearch"><input class="search" id="us" type="search" value="${esc(qs)}" placeholder="Chercher un e-mail ou un pseudo" aria-label="Chercher un compte"><button class="btn" type="submit">Chercher</button></form>
  <div class="section tablewrap"><table class="admin-table"><thead><tr><th>Pseudo</th><th>E-mail</th><th>Âge</th><th>Inscrit le</th><th>Rôle</th><th>Statut</th></tr></thead><tbody>
  ${data.items.map(u => `<tr><td>@${esc(u.pseudo)}</td><td>${esc(u.email)}${u.emailVerified ? "" : ' <span class="pill warn">non confirmé</span>'}</td><td>${u.minor ? "-18" : "18+"}</td><td class="mono">${fmtDs(u.createdAt)}</td>
    <td>${u.id === me().id ? esc(u.role) : `<select data-act="role" data-u="${u.id}" aria-label="Rôle de ${esc(u.pseudo)}">${["user", "moderator", "admin"].map(r => `<option value="${r}" ${u.role === r ? "selected" : ""}>${{ user: "membre", moderator: "modération", admin: "admin" }[r]}</option>`).join("")}</select>`}</td>
    <td>${u.suspendedUntil > Date.now() ? `<span class="pill warn">suspendu jusqu'au ${fmtDs(u.suspendedUntil)}</span> ` : ""}${u.id === me().id ? "" : `<button class="btn small ${u.banned ? "" : "ghost"}" data-act="ban" data-u="${u.id}" data-v="${u.banned ? "0" : "1"}">${u.banned ? "Rétablir" : "Suspendre"}</button>`}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">Aucun compte.</td></tr>`}
  </tbody></table></div>`;
}


/* ---------- mentions légales et confidentialité ---------- */
function viewLegal() {
  VIEW = { name: "legal", data: null };
  const L = BOOT.legal || {}, name = esc(L.name || "Eliot Faggianelli");
  const mail = L.email || ("contact@" + (BOOT.baseUrl || location.origin).replace(/^https?:\/\//, "").replace(/[:/].*$/, ""));
  const contact = `<a href="mailto:${esc(mail)}">${esc(mail)}</a>`;
  const missing = !L.hostName || !L.email;
  return `<div class="page-head"><h1>Mentions légales et confidentialité</h1><p>Qui édite mesvotes.fr, où sont tes données, ce qu'on en fait et comment exercer tes droits.</p></div>
  ${missing && isAdmin() ? `<div class="notice warn">Administration : complète <code>LEGAL_EMAIL</code> et les variables <code>HOSTING_*</code> dans le fichier <code>.env</code> du serveur, puis redémarre (<code>docker compose up -d</code>). Ces informations sont obligatoires.</div>` : ""}
  <div class="legal prose">
    <section class="section"><h2>Éditeur du site</h2>
      <p>mesvotes.fr est édité à titre personnel et non professionnel par <strong>${name}</strong>${L.address ? `, ${esc(L.address)}` : ""}.</p>
      <p>Directeur de la publication : ${name}.</p>
      <p>Contact : ${contact}.</p></section>
    <section class="section"><h2>Hébergement</h2>
      ${L.hostName ? `<p>Le site est hébergé par <strong>${esc(L.hostName)}</strong>${L.hostAddress ? `, ${esc(L.hostAddress)}` : ""}${L.hostPhone ? `, téléphone ${esc(L.hostPhone)}` : ""}.</p>` : `<p>Informations sur l'hébergeur en cours de mise à jour.</p>`}
      ${L.hostLocation ? `<p>Les données sont stockées sur un serveur situé en ${esc(L.hostLocation)}.</p>` : ""}</section>
    <section class="section"><h2>Nature du site</h2>
      <p>mesvotes.fr est un projet citoyen indépendant. Il n'est affilié à aucun parti politique. Les votes organisés ici n'ont aucune valeur légale : ils expriment l'avis des membres de la plateforme.</p></section>
    <section class="section"><h2>Contenus publiés et propriété intellectuelle</h2>
      <p>Le code de mesvotes est un logiciel libre sous licence <a href="https://github.com/eliotfa/mesvotes" rel="noopener">GNU AGPL v3</a>.</p>
      <p>Chaque membre est responsable de ce qu'il publie. En publiant une proposition ou une contribution, tu acceptes qu'elle soit affichée publiquement, amendée par d'autres membres, reprise sous forme de variante et conservée dans l'historique, sous licence <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.fr" rel="noopener">Creative Commons BY-SA 4.0</a>.</p>
      <p>Pour signaler un contenu, utilise le bouton « Signaler » : il est examiné par un jury citoyen (voir la <a href="#/moderation">modération</a>). Pour un contenu manifestement illégal, écris aussi à ${contact} en précisant l'adresse de la page et la raison.</p></section>
    <section class="section"><h2>Tes données personnelles</h2>
      <p><strong>Responsable du traitement :</strong> ${name}, joignable à ${contact}.</p>
      <h3>Ce que nous enregistrons</h3>
      <ul>
        <li><strong>Ton e-mail</strong> : pour te connecter et te prévenir (jury, décisions). Il n'est jamais affiché.</li>
        <li><strong>Ton pseudo</strong> : public, il signe tes propositions et contributions.</li>
        <li><strong>Ta tranche d'âge</strong> (plus ou moins de 18 ans) : pour publier aussi les résultats des mineurs à part.</li>
        <li><strong>Ton mot de passe</strong> : stocké uniquement sous forme chiffrée irréversible (scrypt). Personne ne peut le lire.</li>
        <li><strong>Tes propositions, contributions et fichiers joints</strong> : publics.</li>
        <li><strong>Tes parrainages et tes votes</strong> : jamais publiés un par un. Seuls les totaux sont affichés, et les résultats d'un vote seulement à sa clôture.</li>
        <li><strong>Tes signalements et tes votes de juré</strong> : anonymes pour les autres membres.</li>
        <li><strong>Ton adresse IP</strong> : utilisée quelques minutes en mémoire pour limiter les abus (tentatives de connexion répétées), sans être enregistrée en base. Le serveur web peut la conserver dans ses journaux techniques pendant une durée limitée.</li>
      </ul>
      <h3>Opinions politiques</h3>
      <p>Tes propositions, parrainages et votes peuvent révéler tes opinions politiques, qui sont des données sensibles au sens de l'article 9 du RGPD. Elles ne sont traitées que sur la base de ton <strong>consentement explicite</strong>, donné à l'inscription. Tu peux le retirer à tout moment en supprimant ton compte.</p>
      <h3>Pourquoi</h3>
      <p>Uniquement pour faire fonctionner la plateforme : comptes, débats, votes, modération et sécurité. Pas de publicité, pas de revente, pas de profilage, aucune donnée transmise à un parti ou à un tiers.</p>
      <h3>Qui y a accès</h3>
      <p>L'éditeur et l'hébergeur du serveur${BOOT.mailEnabled ? ", ainsi que le prestataire d'envoi d'e-mails pour les messages qui te sont adressés" : ""}. Les polices de caractères sont chargées depuis Google Fonts, ce qui transmet ton adresse IP à Google lors de l'affichage du site.</p>
      <h3>Combien de temps</h3>
      <p>Tant que ton compte existe. Si tu le supprimes, ton e-mail et ton mot de passe sont effacés et ton pseudo est remplacé par « ancien-membre ». Tes contributions publiques et tes votes restent, anonymes, pour ne pas fausser l'historique des débats ni les résultats. Les sessions de connexion expirent au bout de 30 jours.</p>
      <h3>Cookies</h3>
      <p>Un seul cookie : celui qui te garde connecté. Il est strictement nécessaire au fonctionnement du site, c'est pourquoi aucun bandeau ne te demande ton accord. Aucun cookie de mesure d'audience ni de publicité.</p>
      <h3>Mineurs</h3>
      <p>Les mineurs peuvent participer. En France, une personne de moins de 15 ans doit avoir l'accord d'un de ses parents pour s'inscrire.</p>
      <h3>Tes droits</h3>
      <p>Tu peux accéder à tes données, les corriger, les exporter, t'opposer à leur traitement ou demander leur effacement. La suppression du compte est immédiate depuis la page <a href="#/compte">Mon compte</a>. Pour le reste, écris à ${contact}. Si tu estimes que tes droits ne sont pas respectés, tu peux saisir la <a href="https://www.cnil.fr/fr/plaintes" rel="noopener">CNIL</a>.</p>
    </section>
    <p class="muted" style="font-size:13px">Dernière mise à jour : octobre 2026.</p>
  </div>`;
}

/* ---------- pages d'information ---------- */
async function viewHow() {
  const j = await api("GET", "/api/journal"); VIEW = { name: "how", data: j };
  const r = cstNow().params;
  const kindText = {
    loi: "Un texte nouveau. S'il est adopté, il entre dans le recueil des lois en version 1.",
    modif: "On part du texte en vigueur d'une loi et on le réécrit. Les différences s'affichent mot par mot, comme sur GitHub. Si la modification est adoptée, la loi passe à la version suivante.",
    abrog: "On demande la suppression d'une loi, avec un exposé des motifs. Si l'abrogation est adoptée, la loi reste consultable mais n'est plus en vigueur.",
    const: "On change une règle chiffrée (durées, seuils, majorités) ou un texte de principe. Si deux révisions se chevauchent, seules les règles modifiées par chacune s'appliquent, comme une fusion de branches."
  };
  return `<div class="page-head"><h1>Comment ça marche</h1><p>Une proposition suit toujours le même chemin, en cinq étapes. Les durées et les seuils viennent de la Constitution en vigueur (version ${cstNow().n}) : ils changent si une révision est adoptée.</p></div>
  <div class="steps">
    <div class="stepline" style="--c:var(--ph-projet)"><div class="lab">Projet<small>${r.projetMin} à ${r.projetMax} jours</small></div><p>Un inscrit dépose une idée, avec fichiers, liens, thèmes et tags. Tout le monde peut commenter, apporter une source ou proposer un amendement sur un paragraphe précis. Le porteur intègre ou refuse chaque amendement. Chaque version est gardée, avec ses différences.</p></div>
    <div class="stepline" style="--c:var(--ph-parrainage)"><div class="lab">Parrainage<small>${r.parrainageDays} jours max</small></div><p>Le texte est figé. Il doit réunir ${n_(r.parrainagePct)} % des inscrits en parrains, avec un minimum de ${r.parrainageMin}. Parrainer ne veut pas dire être pour, mais « ce sujet mérite un vote ». Sans assez de parrains, la proposition est archivée.</p></div>
    <div class="stepline" style="--c:var(--ph-deliberation)"><div class="lab">Délibération<small>${r.delibMin} à ${r.delibMax} jours</small></div><p>Le vote est annoncé. Chacun peut analyser la proposition dans sa globalité, lire l'historique de sa construction et débattre. Le temps long évite les votes sous le coup de l'émotion.</p></div>
    <div class="stepline" style="--c:var(--ph-vote)"><div class="lab">Vote<small>${r.voteDays} jours</small></div><p>Pour, contre ou abstention, modifiable jusqu'à la clôture. Les résultats restent cachés jusqu'à la fin.</p></div>
    <div class="stepline" style="--c:var(--ph-fin)"><div class="lab">Résultat<small>Archivé</small></div><p>Une loi passe avec plus de ${n_(r.majorityPct)} % de « pour » et au moins ${n_(r.quorumPct)} % de participation. Une révision de la Constitution demande plus de ${n_(r.constMajorityPct)} % et ${n_(r.constQuorumPct)} % de participation. Tout s'applique automatiquement à la clôture.</p></div>
  </div>
  <h2 class="h-sec">Quatre types de propositions</h2>
  <div class="grid2 prose">${Object.entries(KINDS).map(([k, v]) => `<div class="section"><h2>${v.label}</h2><p style="margin:0">${kindText[k]}</p></div>`).join("")}</div>
  <div class="grid2 prose">
    <div class="section"><h2>Qui peut participer</h2><ul>
      <li>Tout le monde, avec un e-mail, un pseudo et un mot de passe.</li>
      <li>Les mineurs aussi : ils proposent, débattent et votent. Leurs résultats sont aussi affichés à part.</li>
      <li>Toute proposition peut être reprise par n'importe qui sous forme de variante.</li>
      <li>Plus tard : une vérification d'identité pour garantir une personne = un compte.</li></ul></div>
    <div class="section"><h2>Comment on modère</h2><ul>
      <li><strong>Filtre automatique</strong> : insultes, haine, menaces, données personnelles, majuscules. L'auteur sait pourquoi.</li>
      <li><strong>Signalement</strong> d'une proposition, d'une contribution ou d'un compte, avec un motif.</li>
      <li><strong>Jury citoyen</strong> : dès ${r.modReports} signalements, ${r.modJury} inscrits tirés au sort choisissent la mesure ; on retient la médiane.</li>
      <li><strong>Appel</strong> possible une fois, devant un jury élargi.</li>
      <li><strong>Journal public</strong> de chaque décision, sans le contenu. <a href="#/moderation">Voir les décisions</a></li></ul></div>
  </div>
  <div class="section prose"><h2>Journal de modération</h2><ul class="journal">${j.items.map(x => `<li><span class="dt">${fmtDs(x.date)}</span><span>${esc(x.text)}</span></li>`).join("") || `<li><span></span><span class="muted">Rien pour l'instant.</span></li>`}</ul></div>`;
}
async function view2027() {
  const data = await api("GET", "/api/proposals?only27=1&limit=200"); VIEW = { name: "y2027", data };
  return `<div class="page-head"><h1>Présidentielle 2027 :<br>le cahier du peuple</h1><p>Les propositions marquées « 2027 » forment un cahier citoyen ouvert à tous les candidats, quel que soit leur parti. On ne soutient personne : on met des idées sur la table, et chaque candidat dit ce qu'il en pense.</p></div>
  <div class="grid2 prose">
    <div class="section"><h2>Le principe</h2><ul>
      <li>N'importe quelle proposition peut rejoindre le cahier 2027 en cochant la case au dépôt.</li>
      <li>Elle suit le même parcours que les autres : construction, parrainage, débat, vote.</li>
      <li>Chaque proposition adoptée est envoyée à toutes les équipes de campagne.</li>
      <li>Leurs réponses (pour, contre, à amender) sont publiées côte à côte.</li></ul></div>
    <div class="section"><h2>Le problème du calendrier</h2><p style="margin:0">Le premier tour a lieu au printemps 2027. Avec ${cstNow().params.delibMin} jours minimum de délibération, peu de propositions arriveront au vote à temps. Un « mode campagne » peut être créé par une révision de la Constitution.</p>
      <a class="btn small" href="#/proposer/const" style="margin-top:12px;text-decoration:none;color:inherit">Proposer une révision</a></div>
  </div>
  <h2 class="h-sec">Dans le cahier · ${data.total}</h2>
  <div class="list">${data.items.map(cardHtml).join("") || `<div class="empty">Aucune proposition pour l'instant.</div>`}</div>`;
}

/* ---------- routeur ---------- */
function parseHash() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [p, qs] = h.split("?");
  return { parts: p.split("/").filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(qs || "") };
}
let renderSeq = 0;
async function render(scrollTop = true) {
  const seq = ++renderSeq, { parts, params } = parseHash(), app = $("#app");
  try {
    let html;
    switch (parts[0]) {
      case undefined: html = await viewHome(); break;
      case "p": html = await viewDetail(parts[1]); break;
      case "lois": html = await viewLaws(); break;
      case "loi": html = await viewLaw(parts[1]); break;
      case "constitution": html = await viewConst(); break;
      case "2027": html = await view2027(); break;
      case "comment": html = await viewHow(); break;
      case "proposer": html = await viewNew(parts[1], parts[2]); break;
      case "variante": html = await viewFork(parts[1]); break;
      case "connexion": html = me() ? await viewAccount(params) : viewLogin(); break;
      case "inscription": html = viewRegister(); break;
      case "reinitialiser": html = viewReset(params); break;
      case "compte": html = await viewAccount(params); break;
      case "moderation": html = await viewMod(); break;
      case "affaire": html = await viewCase(parts[1]); break;
      case "u": html = await viewProfile(parts[1]); break;
      case "mentions-legales": html = viewLegal(); break;
      case "admin": html = await viewAdmin(params); break;
      default: VIEW = { name: "404" }; html = `<div class="empty">Page introuvable. <a href="#/">Retour à l'accueil</a></div>`;
    }
    if (seq !== renderSeq) return;
    renderHeader();
    app.innerHTML = html;
    if (scrollTop) window.scrollTo(0, 0);
  } catch (e) {
    if (seq !== renderSeq) return;
    renderHeader();
    app.innerHTML = `<div class="empty">${esc(e.status === 404 ? "Cette page n'existe pas ou plus." : e.message)}<br><a href="#/">Retour à l'accueil</a></div>`;
  }
}
const rerender = () => render(false);
const go = h => { if (location.hash === h) render(); else location.hash = h; };

/* ---------- actions ---------- */
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg); return r; }
  catch (e) { toast(e.body?.moderation ? e.body.moderation.msg : e.message); if (e.status === 401) { UI.after = location.hash; go("#/connexion"); } return null; }
}

document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const a = el.dataset.act, d = VIEW && VIEW.data;
  if (a === "ntype") return;
  if (a === "login-then") { UI.after = location.hash; return; }
  switch (a) {
    case "phasef": UI.f.phase = UI.f.phase === el.dataset.f ? "" : el.dataset.f; return rerender();
    case "tagf": UI.f.tag = UI.f.tag === el.dataset.t ? "" : el.dataset.t; return rerender();
    case "gofilter": UI.f = F0(); UI.f[el.dataset.k] = el.dataset.val; UI.showFilters = true; return go("#/");
    case "only27": UI.f.only27 = !UI.f.only27; return rerender();
    case "mine": UI.f.mine = !UI.f.mine; return rerender();
    case "mine-list": UI.f = F0(); UI.f.mine = true; return go("#/");
    case "toggle-filters": UI.showFilters = !UI.showFilters; return rerender();
    case "clearf": { const k = el.dataset.k; UI.f[k] = (k === "only27" || k === "mine") ? false : ""; return rerender(); }
    case "clearall": UI.f = F0(); return rerender();
    case "ver": UI.openVer = UI.openVer === el.dataset.k ? null : el.dataset.k; return rerender();
    case "scroll-disc": $("#discussion")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); return;
    case "edit": UI.editing = true; return rerender();
    case "cancel-edit": UI.editing = false; return rerender();
    case "edit-tags": UI.editingTags = true; return rerender();
    case "cancel-tags": UI.editingTags = false; return rerender();
    case "newkind": captureNew(); UI.newKind = el.dataset.k; delete UI.prefill.text; delete UI.prefill.cst; UI.prefill.title = ""; $("#app").innerHTML = newHtml(); return;
    case "parrain": {
      const r = await act(() => api("POST", `/api/proposals/${d.id}/parrainage`, { on: !d.myParrain }));
      if (r) { toast(r.phase === "deliberation" ? "Seuil atteint ! La délibération commence." : d.myParrain ? "Parrainage retiré." : "Merci, ton parrainage est compté."); rerender(); }
      return;
    }
    case "vote": {
      const r = await act(() => api("POST", `/api/proposals/${d.id}/vote`, { choice: el.dataset.v }));
      if (r) { UI.receipt = { id: d.id, code: r.receipt }; rerender(); }
      return;
    }
    case "receipt-done": {
      if (!confirm("As-tu bien noté ton code ? Il ne sera plus affiché.")) return;
      UI.receipt = null; rerender();
      return;
    }
    case "decide":
      if (await act(() => api("POST", `/api/notes/${el.dataset.n}/decision`, { decision: el.dataset.v }), el.dataset.v === "accept" ? "Amendement intégré : nouvelle version publiée." : "Amendement non retenu. Il reste visible dans le débat.")) rerender();
      return;
    case "report":
      if (!me()) { UI.after = location.hash; return go("#/connexion"); }
      openReport(el.dataset.type, el.dataset.id); return;
    case "close-modal": if (e.target === el) closeModal(); return;
    case "close-modal-btn": closeModal(); return;
    case "del-vote": {
      if (!me()) { UI.after = location.hash; return go("#/connexion"); }
      const type = el.dataset.type, on = el.dataset.on === "1";
      const r = await act(() => api("POST", `/api/deletions/${type}/${el.dataset.id}`, { on }));
      if (!r) return;
      if (r.deleted) { toast("Supprimé définitivement par un vote des inscrits."); return type === "proposal" ? go("#/") : rerender(); }
      toast(on ? "Ton vote pour la suppression est compté." : "Vote retiré.");
      rerender();
      return;
    }
    case "urgent":
      if (!el.dataset.confirm) { el.dataset.confirm = "1"; el.textContent = "Confirmer le retrait ?"; return; }
      if (await act(() => api("POST", "/api/mod/urgent", { type: el.dataset.type, id: el.dataset.id }), "Retiré. L'intervention est inscrite au journal public.")) rerender();
      return;
    case "appeal": {
      const r = await act(() => api("POST", `/api/cases/${el.dataset.id}/appeal`), "Appel enregistré : un nouveau jury va réexaminer l'affaire.");
      if (r) go("#/affaire/" + r.caseId);
      return;
    }
    case "advance": {
      const r = await act(() => api("POST", `/api/proposals/${d.id}/advance`));
      if (r) { await loadBoot(); toast(r.result ? (r.result.outcome === "adopted" ? "Adoptée. " + (r.result.applied || "") : r.result.outcome === "expired" ? "Archivée : parrainage insuffisant." : "Rejetée.") : "Étape suivante."); rerender(); }
      return;
    }
    case "mod-prop":
      if (await act(() => api("POST", `/api/mod/proposals/${d.id}`, { action: el.dataset.v }), el.dataset.v === "hide" ? "Proposition masquée." : "Proposition rétablie.")) rerender();
      return;
    case "ban":
      if (await act(() => api("POST", `/api/admin/users/${el.dataset.u}`, { banned: el.dataset.v === "1" }), el.dataset.v === "1" ? "Compte suspendu." : "Compte rétabli.")) rerender();
      return;
    case "resend": await act(() => api("POST", "/api/auth/resend"), "Lien de confirmation renvoyé."); return;
    case "share": {
      const url = BOOT.baseUrl || location.origin;
      try { await navigator.clipboard.writeText(url); toast("Lien copié : " + url); }
      catch { toast("Copie ce lien : " + url); }
      return;
    }
    case "logout": UI.receipt = null; await act(() => api("POST", "/api/auth/logout")); await loadBoot(); toast("Déconnecté."); return go("#/");
  }
});

document.addEventListener("change", async e => {
  const el = e.target;
  if (el.dataset.act === "ntype") { const keep = $("#n-text")?.value || ""; UI.noteType = el.value; await rerender(); const t = $("#n-text"); if (t) t.value = keep; return; }
  if (el.dataset.f && el.closest("#filters")) { UI.f[el.dataset.f] = el.value; await rerender(); document.getElementById(el.id)?.focus(); return; }
  if (el.id === "n-para") { const ps = paras(curV(VIEW.data).text); $("#n-proposed").value = ps[+el.value - 1] || ""; return; }
  if (el.id === "p-law") { captureNew(); UI.prefill.lawId = el.value; delete UI.prefill.text; UI.prefill.title = ""; UI.prefill.themes = null; UI.prefill.tags = null; $("#app").innerHTML = newHtml(); $("#p-law")?.focus(); return; }
  if (el.id === "lstatus") { UI.lawStatus = el.value; $("#lawlist").innerHTML = lawCards(); return; }
  if (el.dataset.act === "role") { if (await act(() => api("POST", `/api/admin/users/${el.dataset.u}`, { role: el.value }), "Rôle mis à jour.")) rerender(); }
});

document.addEventListener("input", e => {
  const el = e.target;
  if (el.id === "q") { UI.f.q = el.value; clearTimeout(qT); qT = setTimeout(refreshList, 200); return; }
  if (el.id === "lq") { UI.lawQ = el.value; $("#lawlist").innerHTML = lawCards(); return; }
  if (el.id === "p-text" && UI.newKind === "modif" && $("#p-diff")) {
    const l = VIEW.data.laws.find(x => x.id === $("#p-law").value);
    $("#p-diff").innerHTML = diffView(l.versions[l.versions.length - 1].text, el.value).html; return;
  }
  if (el.classList.contains("cst-in")) {
    const pfx = el.id.split("-")[0], box = $(`#${pfx}-preview`); if (!box) return;
    const t = readCst(pfx); box.innerHTML = cstPreview(cstNow(), t);
    PARAMS.forEach(p => $(`#${pfx}-${p.k}`).closest("tr").classList.toggle("changed", t.params[p.k] !== cstNow().params[p.k]));
  }
});

async function uploadFiles(input, box) {
  const ids = [];
  for (const file of [...(input?.files || [])].slice(0, 10)) {
    box.innerHTML = `<div class="notice">Envoi de « ${esc(file.name)} »…</div>`;
    const r = await api("POST", "/api/uploads", undefined, file, { "x-file-name": encodeURIComponent(file.name), "Content-Type": file.type || "application/octet-stream" });
    ids.push(r.id);
  }
  box.innerHTML = "";
  return ids;
}

document.addEventListener("submit", async e => {
  const f = e.target; if (!f.dataset.form) return;
  e.preventDefault();
  const box = f.querySelector(".form-msg"), btn = f.querySelector("[type=submit]");
  const kind = f.dataset.form, d = VIEW && VIEW.data;
  const local = text => { const r = moderate(text); if (r) { box.innerHTML = errBox("Message retenu par le filtre de modération", r.msg); return false; } return true; };
  if (btn) btn.disabled = true;
  try {
    if (kind === "login") {
      const antibot = await takeAntibot(box);
      await api("POST", "/api/auth/login", { email: $("#l-email").value, password: $("#l-pass").value, nepasremplir: f.nepasremplir.value, antibot });
      await loadBoot(); toast(`Bonjour @${me().pseudo} !`);
      const back = UI.after && !/connexion|inscription/.test(UI.after) ? UI.after : "#/"; UI.after = "#/"; go(back);
    }
    else if (kind === "register") {
      const antibot = await takeAntibot(box);
      await api("POST", "/api/auth/register", { nepasremplir: f.nepasremplir.value, antibot, email: $("#r-email").value, pseudo: $("#r-pseudo").value, password: $("#r-pass").value, minor: f.querySelector("input[name=age]:checked").value === "min", consent: $("#r-consent").checked });
      await loadBoot();
      toast(BOOT.mailEnabled ? "Compte créé. Confirme ton adresse avec le lien reçu par e-mail." : `Bienvenue @${me().pseudo} !`);
      const back = UI.after && !/connexion|inscription/.test(UI.after) ? UI.after : "#/"; UI.after = "#/"; go(back);
    }
    else if (kind === "forgot") { const antibot = await takeAntibot(box); await api("POST", "/api/auth/forgot", { email: $("#fe").value, nepasremplir: f.nepasremplir.value, antibot }); box.innerHTML = `<div class="notice ok">Si un compte existe avec cet e-mail, un lien vient d'être envoyé.</div>`; }
    else if (kind === "reset") { await api("POST", "/api/auth/reset", { token: f.dataset.t, password: $("#np").value }); await loadBoot(); toast("Mot de passe enregistré."); go("#/"); }
    else if (kind === "password") { await api("PATCH", "/api/me", { currentPassword: $("#cp").value, newPassword: $("#cn").value }); f.reset(); toast("Mot de passe modifié."); }
    else if (kind === "delete") { await api("DELETE", "/api/me", { password: $("#dp").value }); await loadBoot(); toast("Compte supprimé."); go("#/"); }
    else if (kind === "usersearch") { go("#/admin?q=" + encodeURIComponent($("#us").value)); }
    else if (kind === "report") {
      const reason = f.querySelector("input[name=reason]:checked")?.value;
      if (!reason) { box.innerHTML = errBox("", "Choisis un motif."); return; }
      const r = await api("POST", "/api/reports", { type: f.dataset.type, id: f.dataset.id, reason, comment: $("#rp-comment").value });
      closeModal();
      toast(r.opened ? "Signalement envoyé : une affaire est ouverte et un jury citoyen va l'examiner." : "Signalement envoyé. Merci.");
      await loadBoot(); await rerender();
    }
    else if (kind === "jury") {
      const action = f.querySelector("input[name=action]:checked")?.value;
      if (!action) { box.innerHTML = errBox("", "Choisis une mesure."); return; }
      const r = await api("POST", `/api/cases/${d.id}/vote`, { action, comment: $("#j-comment").value, receipt: $("#rv-code")?.value });
      if (r.receipt) UI.receipt = { id: d.id, code: r.receipt };
      toast(r.closed ? "Vote enregistré. Tous les jurés ont voté : l'affaire est close." : r.receipt ? "Vote enregistré." : "Vote changé.");
      await loadBoot(); await rerender();
    }
    else if (kind === "revote") {
      const choice = f.querySelector("input[name=choice]:checked")?.value;
      if (!choice) { box.innerHTML = errBox("", "Choisis ton vote."); return; }
      await api("POST", `/api/proposals/${d.id}/vote`, { choice: choice === "x" ? null : choice, receipt: $("#rv-code").value });
      toast(choice === "x" ? "Vote retiré." : "Vote changé.");
      await rerender();
    }
    else if (kind === "note") {
      const text = $("#n-text").value.trim(), proposed = $("#n-proposed") ? $("#n-proposed").value.trim() : "";
      if (!local(text + "\n" + proposed)) return;
      await api("POST", `/api/proposals/${d.id}/notes`, { type: UI.noteType, text, para: $("#n-para") ? +$("#n-para").value : undefined, proposed });
      toast(UI.noteType === "amend" ? (d.isAuthor ? "Amendement publié. Tu peux l'intégrer." : "Amendement publié. Le porteur va le lire.") : "Contribution publiée.");
      await rerender();
    }
    else if (kind === "tags") {
      const themes = [...f.querySelectorAll("input[name=theme]:checked")].map(x => x.value);
      await api("PATCH", `/api/proposals/${d.id}/meta`, { themes, tags: $("#t-tags").value });
      UI.editingTags = false; toast("Thèmes et tags mis à jour."); await rerender();
    }
    else if (kind === "edit") {
      const body = { text: $("#edit-text").value, note: $("#edit-note").value };
      if (d.kind === "const") { body.cst = readCst("e"); const err = validateCst(body.cst); if (err) { box.innerHTML = errBox("Règle invalide", err); return; } }
      if (!local(body.text + "\n" + body.note)) return;
      const r = await api("POST", `/api/proposals/${d.id}/versions`, body);
      UI.editing = false; toast(`Version ${r.n} publiée.`); await rerender();
    }
    else if (kind === "new") {
      const k = UI.newKind;
      const body = {
        kind: k, title: $("#p-title").value, summary: $("#p-summary").value, text: $("#p-text").value, tags: $("#p-tags").value,
        themes: [...f.querySelectorAll("input[name=theme]:checked")].map(x => x.value), is2027: $("#p-2027").checked,
        projetDays: +$("#p-pdays").value, delibDays: +$("#p-ddays").value, links: $("#p-links").value, forkOf: UI.prefill?.forkOf || null,
        lawId: $("#p-law") ? $("#p-law").value : null
      };
      if (k === "const") { body.cst = readCst("c"); const err = validateCst(body.cst); if (err) { box.innerHTML = errBox("Règle invalide", err); return; } }
      if (!local([body.title, body.summary, body.text, body.tags].join("\n"))) return;
      body.files = await uploadFiles($("#p-files"), box);
      const r = await api("POST", "/api/proposals", body);
      UI.prefill = null; toast("Proposition déposée. Elle est ouverte aux contributions."); go("#/p/" + r.id);
    }
  } catch (err) { showError(box, err); }
  finally { if (btn && document.contains(btn)) btn.disabled = false; }
});

document.addEventListener("keydown", e => { if (e.key === "Escape" && $("#modal-root").innerHTML) closeModal(); });
window.addEventListener("hashchange", () => { closeModal(); UI.receipt = null; UI.editing = false; UI.editingTags = false; UI.openVer = null; if (!location.hash.startsWith("#/proposer") && !location.hash.startsWith("#/variante")) UI.prefill = null;
  // Rafraîchit le compte (notifications, jury, suspension) à chaque changement de page.
  loadBoot().catch(() => {}).finally(() => render()); });

(async () => {
  try { await loadBoot(); }
  catch (e) { $("#app").innerHTML = `<div class="empty">Le serveur ne répond pas. Réessaie dans un instant.</div>`; return; }
  render();
})();
