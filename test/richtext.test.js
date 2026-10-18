import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineHtml, blockHtml, editorHtml, plainText } from "../public/shared/richtext.js";

test("gras, italique et astérisques littéraux", () => {
  assert.equal(inlineHtml("un **mot** et *deux*"), "un <strong>mot</strong> et <em>deux</em>");
  assert.equal(inlineHtml("***les deux***"), "<strong><em>les deux</em></strong>");
  assert.equal(inlineHtml("2 * 3 * 4"), "2 * 3 * 4");
  assert.equal(inlineHtml("note\\* seule"), "note* seule");
  assert.equal(inlineHtml("**non fermé"), "**non fermé");
});

test("le HTML saisi reste échappé", () => {
  assert.equal(inlineHtml('<script>alert(1)</script> **<img src=x onerror=alert(1)>**'),
    "&lt;script&gt;alert(1)&lt;/script&gt; <strong>&lt;img src=x onerror=alert(1)&gt;</strong>");
  assert.ok(!blockHtml("## <b>x</b>").includes("<b>"));
});

test("blocs : intertitre, listes, retours à la ligne", () => {
  assert.equal(blockHtml("## Titre"), "<h3>Titre</h3>");
  assert.equal(blockHtml("- a\n- **b**"), "<ul><li>a</li><li><strong>b</strong></li></ul>");
  assert.equal(blockHtml("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(blockHtml("Sont concernés :\n- a\n- b"), "<p>Sont concernés :</p><ul><li>a</li><li>b</li></ul>");
  assert.equal(blockHtml("ligne 1\nligne 2"), "<p>ligne 1<br>ligne 2</p>");
});

test("éditeur : un élément par paragraphe", () => {
  assert.equal(editorHtml(""), "<p><br></p>");
  assert.equal(editorHtml("## T\n\n- a\n- b\n\nx\n- y"), "<h3>T</h3><ul><li>a</li><li>b</li></ul><p>x<br>- y</p>");
});

test("texte brut sans marqueurs", () => {
  assert.equal(plainText("## **Titre** *x*"), "Titre x");
  assert.equal(plainText("- a\n1. b"), "a\n1. b");
});
