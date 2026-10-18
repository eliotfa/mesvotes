// Mise en page légère des textes de loi (partagé navigateur / serveur, aucune dépendance).
// Le texte reste du texte brut : on ne stocke jamais de HTML, donc rien à assainir côté serveur.
// Chaque bloc séparé par une ligne vide reste un paragraphe numéroté (§1, §2…).
//   **gras**   *italique*   \* (astérisque littéral)
//   « ## Intertitre » en début de bloc
//   lignes « - élément » (liste à puces) ou « 1. élément » (liste numérotée)
import { esc, paras } from "./util.js";

const UL = /^\s*[-•]\s+/, OL = /^\s*\d+[.)]\s+/, H = /^##\s+/;
const URL_RE = /(https?:\/\/[^\s<]+)/g;

/** Découpe une ligne en segments { t, b, i } : seuls les marqueurs appariés comptent. */
function segments(line) {
  const toks = String(line).split(/(\\\*|\*\*|\*)/).filter(x => x !== "");
  const isSp = c => !c || /\s/.test(c);
  const kind = toks.map((t, k) => {
    if (t === "\\*") return "lit";
    if (t !== "*" && t !== "**") return "txt";
    const prev = (toks[k - 1] || "").slice(-1), next = (toks[k + 1] || "").charAt(0);
    return isSp(prev) && isSp(next) ? "lit" : "mk";
  });
  const active = new Set();
  for (const m of ["**", "*"]) {
    const idx = toks.map((t, k) => (t === m && kind[k] === "mk" ? k : -1)).filter(k => k >= 0);
    for (let j = 0; j + 1 < idx.length; j += 2) active.add(idx[j]).add(idx[j + 1]);
  }
  const out = []; let b = false, i = false;
  toks.forEach((t, k) => {
    if (active.has(k)) { if (t === "**") b = !b; else i = !i; return; }
    const s = t === "\\*" ? "*" : t, last = out[out.length - 1];
    if (last && last.b === b && last.i === i) last.t += s; else out.push({ t: s, b, i });
  });
  return out;
}

/** Une ligne en HTML échappé, avec <strong>/<em> (et liens si demandé). */
export function inlineHtml(line, { links = false } = {}) {
  return segments(line).map(({ t, b, i }) => {
    let h = esc(t);
    if (links) h = h.replace(URL_RE, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    if (i) h = `<em>${h}</em>`;
    if (b) h = `<strong>${h}</strong>`;
    return h;
  }).join("");
}

/** Un paragraphe (bloc) en HTML : intertitre, listes, ou paragraphe avec retours à la ligne. */
export function blockHtml(block, opts) {
  const lines = String(block).split("\n");
  if (lines.length === 1 && H.test(lines[0])) return `<h3>${inlineHtml(lines[0].replace(H, ""), opts)}</h3>`;
  let html = "", run = null;
  const close = () => {
    if (!run) return;
    html += run.tag === "p" ? `<p>${run.items.join("<br>")}</p>` : `<${run.tag}>${run.items.map(x => `<li>${x}</li>`).join("")}</${run.tag}>`;
    run = null;
  };
  for (const l of lines) {
    const tag = UL.test(l) ? "ul" : OL.test(l) ? "ol" : "p";
    if (!run || run.tag !== tag) { close(); run = { tag, items: [] }; }
    run.items.push(inlineHtml(tag === "p" ? l : l.replace(tag === "ul" ? UL : OL, ""), opts));
  }
  close();
  return html;
}

/** HTML de départ de l'éditeur : un élément par bloc, pour que l'aller-retour garde la numérotation. */
export function editorHtml(text) {
  const html = paras(text).map(b => {
    const lines = b.split("\n");
    if (lines.length === 1 && H.test(b)) return `<h3>${inlineHtml(b.replace(H, ""))}</h3>`;
    if (lines.every(l => UL.test(l))) return `<ul>${lines.map(l => `<li>${inlineHtml(l.replace(UL, ""))}</li>`).join("")}</ul>`;
    if (lines.every(l => OL.test(l))) return `<ol>${lines.map(l => `<li>${inlineHtml(l.replace(OL, ""))}</li>`).join("")}</ol>`;
    return `<p>${lines.map(l => inlineHtml(l)).join("<br>")}</p>`;
  }).join("");
  return html || "<p><br></p>";
}

/** Texte sans marqueurs de mise en forme (résumés, aperçus). */
export const plainText = t => String(t || "").split("\n")
  .map(l => segments(l.replace(H, "").replace(UL, "").replace(OL, m => m.trim() + " ")).map(s => s.t).join("")).join("\n");
