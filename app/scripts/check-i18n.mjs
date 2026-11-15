// Fails the build when a user-visible string bypasses i18n, or when the
// English and Japanese dictionaries disagree on their keys.
//
// Every string in the UI must exist in both languages (PRODUCT.md,
// "Accessibility & Inclusion"). Strings kept slipping in hard-coded — the
// figure export sheet was all Japanese, the pin panel all English — and
// nothing noticed, because each looked fine in the language its author used.
//
// Uses the TypeScript parser, not regexes, so `Promise<void>` is not mistaken
// for JSX text. Run: `node scripts/check-i18n.mjs` (part of `npm run build`).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// Text that is the same in every language, on purpose.
const ALLOWED_TEXT = new Set([
  "English", "日本語",   // a language's own name, in the language picker
  "OpticalTwin",         // the product name
  "mm", "(mm)",          // the unit
]);
const KEYCAP = /^(Ctrl|Shift|Alt|Del|Esc|Enter|⌘)(\s*[+/]\s*\S+)*$/;   // "Ctrl+D", "Del"
const ATTRS = new Set(["title", "aria-label", "placeholder", "alt", "label"]);
const DIALOGS = new Set(["alert", "confirm", "prompt"]);
// Words: two Latin letters in a row, or any kana/kanji.
const WORDY = /[A-Za-z]{2}|[぀-ヿ㐀-鿿]/;

const problems = [];

function isVisibleText(text) {
  const t = text.replace(/\s+/g, " ").trim();
  return t !== "" && WORDY.test(t) && !ALLOWED_TEXT.has(t) && !KEYCAP.test(t);
}

function report(sf, node, what, text) {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  problems.push(`${path.relative(SRC, sf.fileName)}:${line + 1}  ${what} ${JSON.stringify(text.trim())}`);
}

function scanFile(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (ts.isJsxText(node) && isVisibleText(node.text)) {
      report(sf, node, "JSX text", node.text);
    } else if (ts.isJsxAttribute(node) && ATTRS.has(node.name.getText(sf))
      && node.initializer && ts.isStringLiteral(node.initializer)
      && isVisibleText(node.initializer.text)) {
      report(sf, node, `${node.name.getText(sf)}=`, node.initializer.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf).replace(/^window\./, "");
      const arg = node.arguments[0];
      if (DIALOGS.has(callee) && arg
        && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
        && isVisibleText(arg.text)) {
        report(sf, node, `${callee}()`, arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) scanFile(p);
  }
}

/** The keys of `const en = {…}` and `const ja = {…}` in i18n.ts. */
function dictionaryKeys() {
  const file = path.join(SRC, "i18n.ts");
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const dicts = {};
  sf.forEachChild((stmt) => {
    if (!ts.isVariableStatement(stmt)) return;
    for (const decl of stmt.declarationList.declarations) {
      const name = decl.name.getText(sf);
      if ((name === "en" || name === "ja") && decl.initializer
        && ts.isObjectLiteralExpression(decl.initializer)) {
        dicts[name] = decl.initializer.properties.map((p) => p.name.getText(sf));
      }
    }
  });
  return dicts;
}

walk(SRC);

const { en = [], ja = [] } = dictionaryKeys();
const dupes = (keys) => keys.filter((k, i) => keys.indexOf(k) !== i);
for (const k of en.filter((k) => !ja.includes(k))) problems.push(`i18n.ts  "${k}" is in en but not ja`);
for (const k of ja.filter((k) => !en.includes(k))) problems.push(`i18n.ts  "${k}" is in ja but not en`);
for (const k of dupes(en)) problems.push(`i18n.ts  "${k}" appears twice in en`);
for (const k of dupes(ja)) problems.push(`i18n.ts  "${k}" appears twice in ja`);

if (problems.length) {
  console.error("check-i18n: user-visible text must go through t() and exist in both en and ja:\n");
  for (const p of problems) console.error("  " + p);
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}
console.log(`check-i18n: ok (${en.length} keys in en and ja)`);
