// The markup renderer in web/wikitext.js, run in jsdom.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage } = require("./load");

const window = loadPage({ lang: "en" });
const { WikiText } = window;

const WIKI = "text/vnd.tiddlywiki";
const MD = "text/markdown";

function store(tiddlers) {
  const byTitle = new Map(tiddlers.map((item) => [item.title, Object.assign({ type: WIKI, tags: [] }, item)]));
  return {
    exists: (title) => byTitle.has(title),
    get: (title) => byTitle.get(title),
    tagged: (tag) => [...byTitle.values()].filter((item) => item.tags.includes(tag)).map((item) => item.title),
    recent: (n) => [...byTitle.keys()].slice(0, n),
    current: "Here",
    stack: ["Here"],
  };
}

// Arrays made inside the jsdom window are a different realm; compare copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

function render(text, type = WIKI, ctx = store([])) {
  const box = window.document.createElement("div");
  box.append(WikiText.render(text, type, ctx));
  return box;
}

// Every element and attribute of the rendered tree, to look for anything that could run.
function unsafe(box) {
  const found = [];
  box.querySelectorAll("*").forEach((node) => {
    if (/^(script|iframe|object|embed|style)$/i.test(node.tagName)) found.push(node.tagName);
    [...node.attributes].forEach((attr) => {
      if (/^on/i.test(attr.name)) found.push(attr.name);
      if (/^(href|src|data-full)$/.test(attr.name) && /^\s*(javascript|data|vbscript):/i.test(attr.value)) found.push(attr.name + "=" + attr.value);
    });
  });
  return found;
}

test("wikitext formatting", () => {
  const box = render("! Title\n!! Second\n''b'' //i// __u__ ~~s~~ @@m@@ ^^sup^^ ,,sub,, `c`");
  assert.equal(box.querySelector("h2").textContent, "Title");
  assert.equal(box.querySelector("h3").textContent, "Second");
  for (const [tag, text] of [["strong", "b"], ["em", "i"], ["u", "u"], ["s", "s"], ["mark", "m"], ["sup", "sup"], ["sub", "sub"], ["code", "c"]]) {
    assert.equal(box.querySelector(tag).textContent, text, tag);
  }
});

test("links to existing, missing and external targets", () => {
  const box = render("[[Home]] [[label|Nowhere]] [[site|https://example.com/a]] https://example.org/x.", WIKI, store([{ title: "Home", text: "" }]));
  const [home, missing, site, bare] = box.querySelectorAll("a");
  assert.equal(home.dataset.title, "Home");
  assert.ok(!home.classList.contains("missing"));
  assert.equal(missing.textContent, "label");
  assert.equal(missing.dataset.title, "Nowhere");
  assert.ok(missing.classList.contains("missing"));
  assert.equal(site.getAttribute("href"), "https://example.com/a");
  assert.equal(site.getAttribute("target"), "_blank");
  assert.match(site.getAttribute("rel"), /noopener/);
  assert.equal(bare.getAttribute("href"), "https://example.org/x", "the trailing full stop is not part of the address");
});

test("lists, tables, quotes and code", () => {
  const box = render("* a\n** b\n# one\n# two\n\n|!H1|!H2|\n|x|y|\n\n> quoted\n\n<<<\ninner\n<<< Author\n\n```js\n<b>kept</b>\n```");
  assert.equal(box.querySelector("ul > li > ul > li").textContent, "b");
  assert.equal(box.querySelectorAll("ol > li").length, 2);
  assert.deepEqual([...box.querySelectorAll("th")].map((n) => n.textContent), ["H1", "H2"]);
  assert.equal(box.querySelectorAll("blockquote").length, 2);
  assert.equal(box.querySelector("cite").textContent, "Author");
  assert.equal(box.querySelector("pre code").textContent, "<b>kept</b>");
  assert.equal(box.querySelector("pre b"), null);
});

test("markdown subset", () => {
  const box = render("## H\n**b** *i* ~~s~~ [[Home]] [t](https://a.example) ![p](/files/a.png) [l](Nowhere)\n- a\n  - b\n1. x\n\n| a | b |\n|---|---|\n| 1 | 2 |", MD, store([{ title: "Home", text: "" }]));
  assert.equal(box.querySelector("h3").textContent, "H");
  assert.equal(box.querySelector("strong").textContent, "b");
  assert.equal(box.querySelector("img").getAttribute("src"), "/files/a.png");
  assert.ok(box.querySelector('a.missing[data-title="Nowhere"]'));
  assert.ok(box.querySelector('a[data-title="Home"]:not(.missing)'));
  assert.equal(box.querySelector("ul ul li").textContent, "b");
  assert.equal(box.querySelectorAll("td").length, 2);
});

test("plain text stays text", () => {
  const box = render("''not bold'' [[not a link]]\nsecond line", "text/plain");
  assert.equal(box.querySelector("strong"), null);
  assert.equal(box.querySelector("a"), null);
  assert.match(box.textContent, /''not bold'' \[\[not a link\]\]/);
});

test("nothing in the text becomes markup that runs", () => {
  const attacks = [
    "<script>alert(1)</script> <img src=x onerror=alert(1)> <a href=javascript:alert(1)>x</a>",
    "[img[javascript:alert(1)]] [img[data:text/html,<script>alert(1)</script>]] [[x|javascript:alert(1)]] [ext[javascript:alert(1)]]",
    "[img full=\"javascript:alert(1)\" [/files/a.png]]",
    "@@<svg onload=alert(1)>@@ ''<iframe src=x>''",
  ];
  for (const text of attacks) {
    for (const type of [WIKI, MD]) {
      assert.deepEqual(unsafe(render(text, type)), [], type + ": " + text);
    }
  }
  const md = render("[x](javascript:alert(1)) ![y](javascript:alert(1)) <b onclick=alert(1)>b</b>", MD);
  assert.deepEqual(unsafe(md), []);
  assert.match(render("<script>alert(1)</script>").textContent, /<script>alert\(1\)<\/script>/);
});

test("images and videos from /files", () => {
  const box = render("[img[caption|/files/ab/photo.webp]] [img full=\"/files/ab/photo.jpg\" [/files/ab/photo.webp]] [img[/files/ab/clip.mp4]]");
  const [first, second] = box.querySelectorAll("img");
  assert.equal(first.getAttribute("alt"), "caption");
  assert.equal(second.dataset.full, "/files/ab/photo.jpg");
  const video = box.querySelector("video");
  assert.equal(video.getAttribute("src") || video.querySelector("source").getAttribute("src"), "/files/ab/clip.mp4");
});

test("transclusion, loops and the depth limit", () => {
  const chain = Array.from({ length: 10 }, (_, i) => ({ title: "T" + i, text: i < 9 ? "{{T" + (i + 1) + "}}" : "bottom" }));
  const ctx = store([{ title: "Quote", text: "''inside''" }, { title: "Loop", text: "{{Loop}}" }, ...chain]);
  assert.equal(render("{{Quote}}", WIKI, ctx).querySelector(".transclusion strong").textContent, "inside");
  assert.equal(render("text {{Loop}}", WIKI, ctx).querySelector(".macro-error").textContent, "{{Loop}} includes itself");
  const deep = render("{{T0}}", WIKI, ctx);
  assert.ok(deep.querySelectorAll(".transclusion").length <= 6);
  assert.doesNotMatch(deep.textContent, /bottom/);
  assert.ok(render("{{Absent}}", WIKI, ctx).querySelector('a.missing[data-title="Absent"]'));
});

test("a transcluded tiddler without its text asks for it", () => {
  const asked = [];
  const ctx = Object.assign(store([{ title: "Later" }]), { need: (title) => asked.push(title) });
  const box = render("{{Later}}", WIKI, ctx);
  assert.deepEqual(asked, ["Later"]);
  assert.ok(box.querySelector('.transclusion.muted[data-from="Later"]'));
});

test("macros", () => {
  const ctx = store([{ title: "A", text: "", tags: ["Topic"] }, { title: "B", text: "", tags: ["Topic"] }, { title: "C", text: "" }]);
  const tagged = render('<<tagged "Topic">>', WIKI, ctx);
  assert.deepEqual([...tagged.querySelectorAll("a")].map((a) => a.dataset.title), ["A", "B"]);
  assert.equal(render("<<recent 2>>", WIKI, ctx).querySelectorAll("li").length, 2);
  assert.ok(render("<<nonsense x>>", WIKI, ctx).querySelector(".macro-error"));
  assert.ok(render("<<todo>>", WIKI, ctx).querySelector(".macro-error"), "no task source, no summary");
});

test("<<todo>> lists open tasks by tiddler", () => {
  const ctx = Object.assign(store([{ title: "Chores", text: "" }]), {
    interactive: true,
    allTasks: () => [{ title: "Chores", type: WIKI, tasks: [{ index: 1, done: false, text: "fix the ''tap''" }] }],
  });
  const box = render("<<todo>>", WIKI, ctx);
  const box1 = box.querySelector(".todo input.task-box");
  assert.equal(box.querySelector(".todo h4 a").dataset.title, "Chores");
  assert.equal(box1.dataset.tiddler, "Chores");
  assert.equal(box1.dataset.task, "1");
  assert.equal(box.querySelector(".todo .task-text strong").textContent, "tap");
  const loading = Object.assign(store([]), { allTasks: () => null });
  assert.equal(render("<<todo>>", WIKI, loading).textContent, "Loading…");
});

test("task lists render checkboxes in order", () => {
  const text = "* [ ] first\n* [x] second\n```\n* [ ] in code\n```\n** [ ] third";
  const ctx = Object.assign(store([]), { interactive: true });
  const boxes = [...render(text, WIKI, ctx).querySelectorAll("input.task-box")];
  assert.deepEqual(boxes.map((b) => [b.dataset.task, b.checked]), [["0", false], ["1", true], ["2", false]]);
  const readOnly = render(text, WIKI, store([])).querySelector("input.task-box");
  assert.ok(readOnly.disabled);
});

test("tasks() and setTask()", () => {
  const wiki = "* [ ] buy bread\n* [x] call\n```\n* [ ] not a task\n```\n# [X] numbered\n> * [ ] quoted";
  assert.deepEqual(plain(WikiText.tasks(wiki, WIKI).map((task) => [task.index, task.done, task.text])), [
    [0, false, "buy bread"], [1, true, "call"], [2, true, "numbered"], [3, false, "quoted"],
  ]);
  const md = "- [ ] one\n  * [x] two\n1. [ ] three\n* [ ]no space";
  assert.deepEqual(plain(WikiText.tasks(md, MD).map((task) => task.text)), ["one", "two", "three"]);
  assert.deepEqual(plain(WikiText.tasks("* [ ] x", "text/plain")), []);
  assert.equal(WikiText.setTask(wiki, WIKI, 0, true).split("\n")[0], "* [x] buy bread");
  assert.equal(WikiText.setTask(wiki, WIKI, 3, true).split("\n")[6], "> * [x] quoted");
  assert.equal(WikiText.setTask(md, MD, 1, false).split("\n")[1], "  * [ ] two");
  assert.equal(WikiText.setTask(wiki, WIKI, 9, true), null);
});

test("links() skips code, external targets and plain text", () => {
  const links = (text, type = WIKI) => [...WikiText.links(text, type)].sort();
  assert.deepEqual(links("[[A]] [[b|B]] {{C||Template}} {{D!!field}} `[[E]]` ``[[F]]`` [[e|https://x.example]] [[f|/files/a.png]]"), ["A", "B", "C", "D"]);
  assert.deepEqual(links("```\n[[G]]\n```\n[[H]]"), ["H"]);
  assert.deepEqual(links("[t](Some%20Page) ![i](x.png) [m](mailto:a@b.c) [[W]]", MD), ["Some Page", "W"]);
  assert.deepEqual(links("[[A]]", "text/plain"), []);
});
