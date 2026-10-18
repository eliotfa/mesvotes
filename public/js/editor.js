// Éditeur de texte « tel quel » (WYSIWYG) minimal : gras, italique, intertitre, listes.
// Le contenu est reconverti en texte brut balisé (voir shared/richtext.js) dans un <textarea> caché,
// que le reste de l'application lit comme avant.
import { esc } from "../shared/util.js";
import { editorHtml } from "../shared/richtext.js";

const TOOLS = [
  ["bold", "<b>G</b>", "Gras (Ctrl+B)"],
  ["italic", "<i>I</i>", "Italique (Ctrl+I)"],
  ["h3", "Intertitre", "Intertitre"],
  ["insertUnorderedList", "• Liste", "Liste à puces"],
  ["insertOrderedList", "1. Liste", "Liste numérotée"]
];

/** Champ complet : barre d'outils, zone éditable et textarea caché portant l'id lu par l'application. */
export function richField(id, label, hint, value) {
  return `<div class="f"><span id="${id}-lbl">${label}</span>${hint ? ` <small>${hint}</small>` : ""}
    <div class="rte">
      <div class="rte-bar" role="toolbar" aria-label="Mise en forme">${TOOLS.map(([c, h, t]) => `<button type="button" class="rte-btn" data-rte="${c}" title="${t}" aria-label="${t}" aria-pressed="false">${h}</button>`).join("")}</div>
      <div class="rte-area" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="${id}-lbl" data-for="${id}" spellcheck="true">${editorHtml(value)}</div>
    </div>
    <textarea id="${id}" hidden>${esc(value || "")}</textarea></div>`;
}

/* ---------- DOM → texte ---------- */
const BLOCK = /^(P|DIV|BLOCKQUOTE|SECTION|ARTICLE|PRE|TABLE|TBODY|TR|TD|TH)$/;
const tidy = s => s.replace(/ /g, " ").split("\n").map(l => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
const wrap = (s, m) => s.split("\n").map(l => { const x = l.match(/^(\s*)([\s\S]*?)(\s*)$/); return x[2] ? x[1] + m + x[2] + m + x[3] : l; }).join("\n");

function inl(n, st = {}) {
  // Un astérisque entouré d'espaces reste tel quel (jamais pris pour un marqueur) ; sinon on l'échappe.
  if (n.nodeType === 3) return n.nodeValue.replace(/[\r\n]+/g, " ").replace(/\*/g, (m, k, s) => /\s/.test(s[k - 1] || "") && /\s/.test(s[k + 1] || "") ? "*" : "\\*");
  if (n.nodeType !== 1) return "";
  const tag = n.tagName;
  if (tag === "BR") return "\n";
  if (/^(UL|OL|SCRIPT|STYLE|IMG)$/.test(tag)) return "";
  const fw = n.style && n.style.fontWeight, fs = n.style && n.style.fontStyle;
  const b = tag === "B" || tag === "STRONG" || fw === "bold" || +fw >= 600, i = tag === "I" || tag === "EM" || fs === "italic";
  let inner = [...n.childNodes].map(c => inl(c, { b: st.b || b, i: st.i || i })).join("");
  if (BLOCK.test(tag) || /^H[1-6]$/.test(tag) || tag === "LI") inner = "\n" + inner + "\n";
  if (i && !st.i) inner = wrap(inner, "*");
  if (b && !st.b) inner = wrap(inner, "**");
  return inner;
}

function list(el) {
  const out = []; let n = 0;
  for (const li of el.children) {
    if (li.tagName !== "LI") { if (/^(UL|OL)$/.test(li.tagName)) { const t = list(li); if (t) out.push(t); } continue; }
    let txt = ""; const subs = [];
    for (const c of li.childNodes) { if (c.nodeType === 1 && /^(UL|OL)$/.test(c.tagName)) subs.push(c); else txt += inl(c) + (c.nodeType === 1 && BLOCK.test(c.tagName) ? " " : ""); }
    txt = tidy(txt).replace(/\n/g, " ");
    if (txt) out.push((el.tagName === "OL" ? `${++n}. ` : "- ") + txt);
    subs.forEach(s => { const t = list(s); if (t) out.push(t); });
  }
  return out.join("\n");
}

export function editorText(root) {
  const blocks = []; let cur = "";
  const flush = () => { const t = tidy(cur); if (t) blocks.push(t); cur = ""; };
  const walk = node => {
    for (const c of node.childNodes) {
      const tag = c.nodeType === 1 ? c.tagName : "";
      if (BLOCK.test(tag)) { flush(); walk(c); flush(); }
      else if (/^H[1-6]$/.test(tag)) { flush(); const t = tidy(inl(c)).replace(/\n/g, " "); if (t) blocks.push("## " + t); }
      else if (tag === "UL" || tag === "OL") { flush(); const t = list(c); if (t) blocks.push(t); }
      else cur += inl(c);
    }
  };
  walk(root); flush();
  return blocks.join("\n\n");
}

/* ---------- interactions (délégation, comme le reste de l'application) ---------- */
const areaOf = el => el && el.closest && el.closest(".rte")?.querySelector(".rte-area");

function sync(area) {
  const ta = document.getElementById(area.dataset.for); if (!ta) return;
  ta.value = editorText(area);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function refreshBar(area) {
  const bar = area.closest(".rte").querySelector(".rte-bar");
  for (const b of bar.querySelectorAll("[data-rte]")) {
    const c = b.dataset.rte;
    let on = false;
    try { on = c === "h3" ? /^h[1-6]$/i.test(document.queryCommandValue("formatBlock")) : document.queryCommandState(c); } catch { /* navigateur ancien */ }
    b.setAttribute("aria-pressed", String(!!on));
  }
}

/** Texte collé : on garde le texte brut, chaque ligne devient un paragraphe (sauf texte déjà séparé par des lignes vides). */
function pastedHtml(text) {
  let t = String(text).replace(/\r\n?/g, "\n").replace(/^[ \t]*[•◦▪‣·][ \t]*/gm, "- ");
  if (!/\n\s*\n/.test(t)) {
    const lines = t.split("\n").filter(l => l.trim());
    t = lines.map((l, k) => k && (UL_OL.test(l) && UL_OL.test(lines[k - 1])) ? "\n" + l : "\n\n" + l).join("").trim();
  }
  return editorHtml(t);
}
const UL_OL = /^\s*(?:[-•]|\d+[.)])\s+/;

export function initEditors() {
  document.addEventListener("mousedown", e => { if (e.target.closest(".rte-btn")) e.preventDefault(); });
  document.addEventListener("click", e => {
    const btn = e.target.closest(".rte-btn"); if (!btn) return;
    const area = areaOf(btn); area.focus();
    const c = btn.dataset.rte;
    if (c === "h3") document.execCommand("formatBlock", false, /^h[1-6]$/i.test(document.queryCommandValue("formatBlock")) ? "p" : "h3");
    else document.execCommand(c, false, null);
    sync(area); refreshBar(area);
  });
  document.addEventListener("focusin", e => {
    if (!e.target.classList?.contains("rte-area")) return;
    try { document.execCommand("defaultParagraphSeparator", false, "p"); document.execCommand("styleWithCSS", false, false); } catch { /* ignoré */ }
  });
  document.addEventListener("input", e => { if (e.target.classList?.contains("rte-area")) sync(e.target); });
  document.addEventListener("paste", e => {
    const area = e.target.closest?.(".rte-area"); if (!area) return;
    e.preventDefault();
    document.execCommand("insertHTML", false, pastedHtml(e.clipboardData.getData("text/plain")));
    sync(area);
  });
  document.addEventListener("drop", e => { if (e.target.closest?.(".rte-area")) e.preventDefault(); });
  document.addEventListener("selectionchange", () => {
    const n = document.getSelection()?.anchorNode, area = n && (n.nodeType === 1 ? n : n.parentElement)?.closest(".rte-area");
    if (area) refreshBar(area);
  });
}
