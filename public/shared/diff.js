// Différences mot à mot entre deux textes (plus longue sous-séquence commune).
import { esc } from "./util.js";

const tok = s => String(s || "").split(/(\s+)/).filter(x => x !== "");

/** Renvoie une liste d'opérations [["=",txt] | ["-",txt] | ["+",txt]]. */
export function diffOps(a, b) {
  const A = tok(a), B = tok(b), ops = [];
  const push = (t, s) => { const l = ops[ops.length - 1]; if (l && l[0] === t) l[1] += s; else ops.push([t, s]); };
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf), n = a2.length, m = b2.length;
  if (pre) push("=", A.slice(0, pre).join(""));
  if (n * m > 4e6) { if (n) push("-", a2.join("")); if (m) push("+", b2.join("")); }
  else {
    const W = m + 1, L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * W + j] = a2[i] === b2[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { push("=", a2[i]); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { push("-", a2[i]); i++; }
      else { push("+", b2[j]); j++; }
    }
    while (i < n) push("-", a2[i++]);
    while (j < m) push("+", b2[j++]);
  }
  if (suf) push("=", A.slice(A.length - suf).join(""));
  // Un simple espace entre deux changements rejoint le bloc modifié (lecture plus claire).
  const out = []; let del = "", ins = "";
  const flush = () => { if (del) out.push(["-", del]); if (ins) out.push(["+", ins]); del = ""; ins = ""; };
  ops.forEach((o, k) => {
    if (o[0] === "=" && /^\s+$/.test(o[1]) && (del || ins) && ops[k + 1] && ops[k + 1][0] !== "=") { del += o[1]; ins += o[1]; return; }
    if (o[0] === "=") { flush(); out.push(o); } else if (o[0] === "-") del += o[1]; else ins += o[1];
  });
  flush();
  return out;
}

const wc = s => (String(s).match(/\S+/g) || []).length;

/** HTML échappé avec <ins>/<del>, plus le nombre de mots ajoutés et retirés. */
export function diffView(a, b) {
  let add = 0, rem = 0;
  const html = diffOps(a, b).map(([t, s]) => {
    if (t === "=") return esc(s);
    if (t === "-") { rem += wc(s); return `<del>${esc(s)}</del>`; }
    add += wc(s); return `<ins>${esc(s)}</ins>`;
  }).join("");
  return { html, add, rem, changed: add + rem > 0 };
}
