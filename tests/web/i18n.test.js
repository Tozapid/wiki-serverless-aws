// Translations in web/i18n.js: every interface string the page uses has an
// English, French and Italian version, and the language follows the system.
const test = require("node:test");
const assert = require("node:assert/strict");
const { source, loadPage } = require("./load");

const OTHER = ["en", "fr", "it"];
const CYRILLIC = /[А-Яа-яЁё]/;

// Russian strings passed to t(...) in the page code, the keys of the dictionaries.
function usedKeys() {
  const keys = new Set();
  const literal = '"((?:[^"\\\\\\n]|\\\\.)*)"';
  const patterns = [
    new RegExp("\\bt\\(\\s*" + literal, "g"),
    new RegExp("\\bt\\([^()\"\\n]*\\?\\s*" + literal + "\\s*:\\s*" + literal, "g"),
  ];
  for (const file of ["app.js", "wikitext.js"]) {
    const code = source(file);
    for (const pattern of patterns) {
      for (const m of code.matchAll(pattern)) {
        m.slice(1).filter(Boolean).forEach((key) => keys.add(JSON.parse('"' + key + '"')));
      }
    }
  }
  return [...keys].filter((key) => CYRILLIC.test(key));
}

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

test("the page code has strings to translate", () => {
  assert.ok(usedKeys().length > 150, "found " + usedKeys().length);
});

for (const lang of OTHER) {
  test("every interface string is translated: " + lang, () => {
    const { WikiI18n } = loadPage({ lang });
    assert.equal(WikiI18n.lang, lang);
    const missing = usedKeys().filter((key) => CYRILLIC.test(WikiI18n.t(key)));
    assert.deepEqual(missing, []);
  });

  test("translations keep the {placeholders}: " + lang, () => {
    const { WikiI18n } = loadPage({ lang });
    const broken = usedKeys().filter((key) => placeholders(WikiI18n.t(key)) !== placeholders(key));
    assert.deepEqual(broken, []);
  });

  test("help is written in the language: " + lang, () => {
    const help = loadPage({ lang }).WikiI18n.help();
    assert.ok(help.length > 1000);
    assert.doesNotMatch(help, CYRILLIC);
    assert.match(help, /\$:\/DefaultTiddlers/);
  });
}

test("Russian is the text in the code", () => {
  const { WikiI18n } = loadPage({ lang: "ru" });
  assert.equal(WikiI18n.t("Войти"), "Войти");
  assert.equal(WikiI18n.t("Найдено: {count}", { count: 3 }), "Найдено: 3");
  assert.match(WikiI18n.help(), CYRILLIC);
});

test("values fill placeholders, unknown ones stay", () => {
  const { WikiI18n } = loadPage({ lang: "en" });
  assert.equal(WikiI18n.t("Найдено: {count}", { count: 7 }), "Found: 7");
  assert.equal(WikiI18n.t("Найдено: {count}"), "Found: {count}");
  assert.equal(WikiI18n.t("Строка, которой нет"), "Строка, которой нет");
});

test("the system language is used unless one was chosen", () => {
  const pick = (languages, lang) => loadPage({ languages, lang }).WikiI18n;
  assert.equal(pick(["fr-CA", "en-US"]).lang, "fr");
  assert.equal(pick(["de-DE", "it-IT"]).lang, "it");
  assert.equal(pick(["ru"]).lang, "ru");
  assert.equal(pick(["de-DE", "ja"]).lang, "en");
  assert.equal(pick(["de-DE"]).chosen(), false);
  const chosen = pick(["fr-FR"], "ru");
  assert.equal(chosen.lang, "ru");
  assert.equal(chosen.chosen(), true);
  assert.equal(pick(["fr-FR"], "xx").lang, "fr", "an unknown stored value is ignored");
});

test("the page element carries the language", () => {
  assert.equal(loadPage({ lang: "it" }).document.documentElement.lang, "it");
});

test("plural forms follow each language", () => {
  const count = (lang, n) => loadPage({ lang }).WikiI18n.count(n, "файл");
  assert.deepEqual([1, 2, 5, 21].map((n) => count("ru", n)), ["1 файл", "2 файла", "5 файлов", "21 файл"]);
  assert.deepEqual([1, 2].map((n) => count("en", n)), ["1 file", "2 files"]);
  assert.deepEqual([1, 2].map((n) => count("fr", n)), ["1 fichier", "2 fichiers"]);
  assert.equal(count("en", 1500), "1,500 files");
});
