// The page and the Lambda must agree on links and tasks: the server stores
// links for backlinks and the Missing tab and answers <<todo>>, the page
// draws the same text. Both rule sets run on the same documents here.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadPage } = require("./load");

const { WikiText } = loadPage({ lang: "en" });
const LAMBDA = path.join(__dirname, "..", "..", "lambda");
const TYPES = ["text/vnd.tiddlywiki", "text/markdown", "text/plain"];

const PIECES = [
  "[[Plain]]", "[[label|Target]]", "[[ spaced ]]", "[[x|https://example.com]]", "[[f|/files/a.png]]", "[[m|mailto:a@b.c]]",
  "{{Included}}", "{{Tpl||Template}}", "{{Data!!field}}", "`[[InCode]]`", "``[[InDouble]]``",
  "[md](Md%20Page)", "![img](pic.png)", "[ext](https://example.org)", "[js](javascript:alert(1))", "[[Кириллица]]",
  "* [ ] wiki task", "* [x] wiki done", "# [X] numbered", "> * [ ] quoted", "** [ ] nested", "*[ ] no space",
  "- [ ] md task", "  * [x] md nested", "1. [ ] md numbered", "2) [ ] md paren", "- [ ]tight", "+ [ ] plus",
  "```\n* [ ] fenced [[Fenced]]\n```", "  ```js\n- [ ] indented fence\n  ```", "plain words", "",
];

// A fixed pseudo-random mix, so a failure can be repeated.
function documents() {
  let seed = 7;
  const next = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const docs = PIECES.flatMap((piece) => TYPES.map((type) => ({ text: piece, type })));
  for (let i = 0; i < 400; i++) {
    const lines = Array.from({ length: 1 + next(8) }, () => PIECES[next(PIECES.length)] + (next(3) ? "" : " tail [[Tail" + next(5) + "]]"));
    docs.push({ text: lines.join(next(4) ? "\n" : "\r\n"), type: TYPES[next(3)] });
  }
  return docs;
}

function python(docs) {
  const script = [
    "import json, sys",
    "from lambda_app import extract_links, scan_tasks",
    "docs = json.load(sys.stdin)",
    "print(json.dumps([{'links': sorted(extract_links(d['text'], d['type'])), 'tasks': scan_tasks(d['text'], d['type'])} for d in docs]))",
  ].join("\n");
  const out = execFileSync(process.env.PYTHON || "python3", ["-c", script], { cwd: LAMBDA, input: JSON.stringify(docs), encoding: "utf8" });
  return JSON.parse(out);
}

test("links and tasks match the Lambda", () => {
  const docs = documents();
  const server = python(docs);
  const mismatches = [];
  docs.forEach((doc, i) => {
    const page = {
      links: [...WikiText.links(doc.text, doc.type)].sort(),
      tasks: JSON.parse(JSON.stringify(WikiText.tasks(doc.text, doc.type))),
    };
    const expected = { links: [...server[i].links].sort(), tasks: server[i].tasks };
    try {
      assert.deepEqual(page, expected);
    } catch (error) {
      mismatches.push({ doc, page, server: expected });
    }
  });
  assert.deepEqual(mismatches.slice(0, 3), [], mismatches.length + " of " + docs.length + " documents differ");
});
