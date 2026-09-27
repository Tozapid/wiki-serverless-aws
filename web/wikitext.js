// Renders tiddler text into DOM nodes. Nothing from the text is ever parsed as
// HTML: every node is built with createElement and every string is a text node.
// Supported: a TiddlyWiki wikitext subset, a Markdown subset, and plain text.
(function () {
  const MAX_DEPTH = 6;
  const t = (window.WikiI18n && window.WikiI18n.t) || ((text) => text);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value == null || value === false) return;
      if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    });
    [].concat(children || []).forEach((child) => {
      if (child == null || child === false) return;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function isExternal(target) {
    return /^(https?:\/\/|mailto:|\/files\/)/i.test(target);
  }

  function safeHref(target) {
    const value = String(target || "").trim();
    return isExternal(value) ? value : "";
  }

  function safeSrc(target) {
    const value = String(target || "").trim();
    return /^(https?:\/\/|\/files\/)/i.test(value) ? value : "";
  }

  function internalLink(ctx, title, label) {
    const missing = !ctx.exists(title);
    return el("a", {
      class: missing ? "link missing" : "link",
      href: "#" + encodeURIComponent(title),
      "data-title": title,
      title: missing ? t("Тиддлера пока нет") : null,
    }, label);
  }

  function externalLink(href, label) {
    const local = href.startsWith("/files/");
    return el("a", {
      class: local ? "link file" : "link external",
      href: href,
      target: "_blank",
      rel: "noopener noreferrer",
    }, label);
  }

  function linkNode(ctx, label, target) {
    target = target.trim();
    if (isExternal(target)) return externalLink(safeHref(target), label);
    return internalLink(ctx, target, label);
  }

  const VIDEO_RE = /\.(mp4|m4v|webm|ogv|mov)(?:[?#]|$)/i;

  function parseAttrs(text) {
    const attrs = {};
    const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
    let m;
    while ((m = re.exec(text || ""))) attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    return attrs;
  }

  // [img[...]] and ![...](...) show a picture, or a player when the file is a
  // video. A picture opens full size on click: the `full` address when there
  // is one (the original next to a web-sized copy), otherwise itself.
  function imageNode(src, tooltip, attrs, full) {
    const url = safeSrc(src);
    if (!url) return el("span", { class: "muted" }, t("[картинка: {src}]", { src }));
    const options = parseAttrs(attrs);
    const size = (key) => (/^\d{1,4}$/.test(options[key] || "") ? options[key] : null);
    if (VIDEO_RE.test(url)) {
      return el("video", {
        src: url,
        controls: "",
        preload: "metadata",
        playsinline: "",
        title: tooltip || null,
        width: size("width"),
        height: size("height"),
      });
    }
    return el("img", {
      src: url,
      alt: tooltip || "",
      title: tooltip || null,
      loading: "lazy",
      width: size("width"),
      height: size("height"),
      class: "zoomable",
      "data-full": safeSrc(full || options.full || "") || url,
    });
  }

  function trimUrl(url) {
    const match = /[.,;:!?)\]]+$/.exec(url);
    return match ? [url.slice(0, -match[0].length), match[0]] : [url, ""];
  }

  function macroArgs(text) {
    const args = [];
    const pattern = /(?:([\w-]+):)?(?:"""([\s\S]*?)"""|"([^"]*)"|'([^']*)'|\[\[([^\]]*)\]\]|(\S+))/g;
    let match;
    while ((match = pattern.exec(text || ""))) {
      const value = [match[2], match[3], match[4], match[5], match[6]].find((part) => part !== undefined);
      args.push({ name: match[1] || "", value: value || "" });
    }
    return args;
  }

  function titleList(ctx, titles) {
    if (!titles.length) return el("p", { class: "muted" }, t("Пусто"));
    return el("ul", { class: "title-list" }, titles.map((title) => el("li", {}, internalLink(ctx, title, title))));
  }

  function tocNode(ctx, tag, depth, seen) {
    const titles = ctx.tagged(tag);
    if (!titles.length || depth > 4) return null;
    return el("ul", { class: "toc" }, titles.map((title) => {
      if (seen.has(title)) return el("li", {}, internalLink(ctx, title, title));
      const next = new Set(seen).add(title);
      return el("li", {}, [internalLink(ctx, title, title), tocNode(ctx, title, depth + 1, next)]);
    }));
  }

  function macroNode(ctx, name, rawArgs) {
    const args = macroArgs(rawArgs);
    const first = args[0] ? args[0].value : "";
    const named = (key) => (args.find((arg) => arg.name === key) || {}).value;
    if (name === "tagged" || name === "list-links") {
      let tag = name === "tagged" ? first : "";
      const filter = named("filter") || (name === "list-links" ? first : "");
      const inFilter = /\[tag\[([^\]]+)\]\]/.exec(filter || "");
      if (inFilter) tag = inFilter[1];
      if (!tag) return el("code", { class: "macro-error" }, "<<" + name + rawArgs + ">>");
      return titleList(ctx, ctx.tagged(tag));
    }
    if (name === "toc") {
      return tocNode(ctx, first || ctx.current, 0, new Set([first || ctx.current])) || el("p", { class: "muted" }, t("Пусто"));
    }
    if (name === "recent") {
      const count = Math.min(Math.max(parseInt(first, 10) || 10, 1), 100);
      return titleList(ctx, ctx.recent(count));
    }
    if (name === "todo") {
      return todoNode(ctx, named("tag") || first);
    }
    if (name === "now") {
      return document.createTextNode(new Date().toLocaleString((window.WikiI18n && window.WikiI18n.locale) || undefined));
    }
    return el("code", { class: "macro-error", title: t("Неизвестный макрос") }, "<<" + name + rawArgs + ">>");
  }

  // Tasks ---------------------------------------------------------------
  // "* [ ] text" in wikitext and "- [ ] text" in Markdown are tasks. They are
  // numbered in text order, code blocks skipped, the same way here and in
  // setTask, so a click on a box flips the right line of the source.

  const TASK_ITEM_RE = /^\[([ xX])\]\s+/;

  function taskLineRe(type) {
    return type === "text/markdown"
      ? /^(\s*(?:>\s?)*\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\](?=\s)/
      : /^((?:>\s?)*[*#]+\s+)\[([ xX])\](?=\s)/;
  }

  function scanTasks(text, type) {
    if (type === "text/plain") return [];
    const re = taskLineRe(type);
    const found = [];
    let fenced = false;
    String(text || "").replace(/\r\n/g, "\n").split("\n").forEach((line, number) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      const m = re.exec(line);
      if (m) found.push({ line: number, at: m[1].length + 1, done: m[2] !== " ", text: line.slice(m[0].length).trim() });
    });
    return found;
  }

  function tasks(text, type) {
    return scanTasks(text, type).map((task, index) => ({ index, done: task.done, text: task.text }));
  }

  function setTask(text, type, index, done) {
    const task = scanTasks(text, type)[index];
    if (!task) return null;
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    const line = lines[task.line];
    lines[task.line] = line.slice(0, task.at) + (done ? "x" : " ") + line.slice(task.at + 1);
    return lines.join("\n");
  }

  function taskBox(ctx, title, index, done, label) {
    return el("input", {
      type: "checkbox",
      class: "task-box",
      checked: done,
      disabled: !(ctx.interactive && title),
      "data-tiddler": ctx.interactive && title ? title : null,
      "data-task": String(index),
      "aria-label": t(done ? "Сделано: {task}" : "Задача: {task}", { task: label }),
    });
  }

  function taskItem(text, inline, ctx) {
    const m = TASK_ITEM_RE.exec(text);
    if (!m) return null;
    const done = m[1] !== " ";
    const counter = ctx.taskCounter || (ctx.taskCounter = { n: 0 });
    const index = counter.n;
    counter.n += 1;
    const label = el("span", { class: "task-text" });
    inline(label, text.slice(m[0].length), ctx);
    return el("li", { class: done ? "task done" : "task" }, [
      taskBox(ctx, ctx.stack[ctx.stack.length - 1], index, done, label.textContent),
      label,
    ]);
  }

  function todoNode(ctx, tag) {
    if (!ctx.allTasks) return el("code", { class: "macro-error" }, "<<todo>>");
    const groups = ctx.allTasks(tag);
    if (groups === null) return el("p", { class: "muted" }, t("Загружаю…"));
    if (!groups.length) return el("p", { class: "muted" }, tag ? t("С тегом «{tag}» открытых задач нет", { tag }) : t("Открытых задач нет"));
    return el("div", { class: "todo" }, groups.map((group) => el("section", { class: "todo-group" }, [
      el("h4", {}, internalLink(ctx, group.title, group.title)),
      el("ul", { class: "tasks" }, group.tasks.map((task) => {
        const label = el("span", { class: "task-text" });
        (group.type === "text/markdown" ? mdInline : wikiInline)(label, task.text, Object.assign({}, ctx, { stack: ctx.stack.concat(group.title) }));
        return el("li", { class: "task" }, [taskBox(ctx, group.title, task.index, false, label.textContent), label]);
      })),
    ])));
  }

  function transclude(ctx, title, block) {
    title = title.split("||")[0].split("!!")[0].trim();
    if (ctx.stack.includes(title) || ctx.stack.length >= MAX_DEPTH) {
      return el("span", { class: "macro-error" }, t("{{{title}}} включает сам себя", { title }));
    }
    const tiddler = ctx.get(title);
    if (!tiddler) return internalLink(ctx, title, "{{" + title + "}}");
    if (typeof tiddler.text !== "string") {
      // Not loaded yet: ask for it and show a placeholder until it comes.
      if (ctx.need) ctx.need(title);
      return el(block ? "div" : "span", { class: "transclusion muted", "data-from": title }, t("Загружаю…"));
    }
    const inner = Object.assign({}, ctx, { stack: ctx.stack.concat(title), taskCounter: { n: 0 } });
    const node = el(block ? "div" : "span", { class: "transclusion", "data-from": title });
    node.append(render(tiddler.text, tiddler.type, inner, !block));
    return node;
  }

  // Wikitext inline rules. Earlier alternatives win when two start at the same place.
  const WIKI_INLINE = new RegExp([
    "``([\\s\\S]+?)``",
    "`([^`\\n]+)`",
    "\\[\\[([^\\]\\n]+?)\\]\\]",
    "\\[img(\\s[^\\[\\]\\n]*)?\\[([^\\]\\n]+)\\]\\]",
    "\\[ext\\[([^\\]\\n]+)\\]\\]",
    "\\{\\{([^{}\\n]+)\\}\\}",
    "<<([\\w-]+)((?:[^>\\n]|>(?!>))*)>>",
    "''(.+?)''",
    "//(.+?)//",
    "__(.+?)__",
    "~~(.+?)~~",
    "\\^\\^(.+?)\\^\\^",
    ",,(.+?),,",
    "@@(.+?)@@",
    "(https?://[^\\s<>\"']+)",
    "(\\n)",
  ].join("|"), "g");

  function wikiInline(parent, text, ctx) {
    const source = String(text);
    const pattern = new RegExp(WIKI_INLINE.source, "g");
    let last = 0;
    let m;
    while ((m = pattern.exec(source))) {
      if (m.index > last) parent.append(source.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] !== undefined) parent.append(el("code", {}, m[1]));
      else if (m[2] !== undefined) parent.append(el("code", {}, m[2]));
      else if (m[3] !== undefined) {
        const bar = m[3].indexOf("|");
        const label = bar >= 0 ? m[3].slice(0, bar) : m[3];
        const target = bar >= 0 ? m[3].slice(bar + 1) : m[3];
        parent.append(linkNode(ctx, label.trim() || target, target));
      } else if (m[5] !== undefined) {
        const bar = m[5].indexOf("|");
        parent.append(imageNode(bar >= 0 ? m[5].slice(bar + 1) : m[5], bar >= 0 ? m[5].slice(0, bar) : "", m[4]));
      } else if (m[6] !== undefined) {
        const bar = m[6].indexOf("|");
        const href = safeHref(bar >= 0 ? m[6].slice(bar + 1) : m[6]);
        const label = bar >= 0 ? m[6].slice(0, bar) : m[6];
        parent.append(href ? externalLink(href, label) : label);
      } else if (m[7] !== undefined) parent.append(transclude(ctx, m[7], false));
      else if (m[8] !== undefined) parent.append(macroNode(ctx, m[8], m[9] || ""));
      else if (m[17] !== undefined) {
        const [url, tail] = trimUrl(m[17]);
        parent.append(externalLink(url, url));
        if (tail) parent.append(tail);
      } else if (m[18] !== undefined) parent.append(el("br"));
      else {
        const tags = { 10: "strong", 11: "em", 12: "u", 13: "s", 14: "sup", 15: "sub", 16: "mark" };
        for (let group = 10; group <= 16; group += 1) {
          if (m[group] !== undefined) {
            const node = el(tags[group]);
            wikiInline(node, m[group], ctx);
            parent.append(node);
            break;
          }
        }
      }
    }
    if (last < source.length) parent.append(source.slice(last));
  }

  function buildList(items, inline, ctx) {
    const root = document.createDocumentFragment();
    const stack = [];
    items.forEach((item) => {
      let depth = 0;
      while (depth < stack.length && depth < item.marker.length && stack[depth].ch === item.marker[depth]) depth += 1;
      stack.length = Math.min(stack.length, depth);
      while (stack.length < item.marker.length) {
        const ch = item.marker[stack.length];
        const list = el(ch === "#" ? "ol" : "ul");
        const parentLevel = stack[stack.length - 1];
        if (parentLevel) {
          if (!parentLevel.lastLi) {
            parentLevel.lastLi = el("li", { class: "bare" });
            parentLevel.node.append(parentLevel.lastLi);
          }
          parentLevel.lastLi.append(list);
        } else {
          root.append(list);
        }
        stack.push({ ch, node: list, lastLi: null });
      }
      const top = stack[stack.length - 1];
      const li = taskItem(item.text, inline, ctx) || el("li");
      if (!li.childNodes.length) inline(li, item.text, ctx);
      top.node.append(li);
      top.lastLi = li;
    });
    return root;
  }

  function tableNode(rows, ctx) {
    const table = el("table");
    const body = el("tbody");
    rows.forEach((line) => {
      const inner = line.replace(/^\|/, "").replace(/\|\s*$/, "");
      const tr = el("tr");
      inner.split("|").forEach((cell) => {
        const header = cell.startsWith("!");
        const td = el(header ? "th" : "td");
        wikiInline(td, (header ? cell.slice(1) : cell).trim(), ctx);
        tr.append(td);
      });
      body.append(tr);
    });
    table.append(body);
    return el("div", { class: "table-wrap" }, table);
  }

  function renderWiki(source, ctx, inlineOnly) {
    const root = document.createDocumentFragment();
    if (inlineOnly && !/\n\s*\n|^[!*#|>]|^```|^<<<|^---/m.test(source)) {
      wikiInline(root, source, ctx);
      return root;
    }
    const lines = String(source).replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el("p");
      wikiInline(p, para.join("\n"), ctx);
      root.append(p);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (/^```/.test(line)) {
        flush();
        const code = [];
        const lang = line.slice(3).trim();
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
        root.append(el("pre", { "data-lang": lang || null }, el("code", {}, code.join("\n"))));
        i += 1;
        continue;
      }
      if (/^<<<\s*$/.test(line)) {
        flush();
        const quote = [];
        i += 1;
        while (i < lines.length && !/^<<</.test(lines[i])) quote.push(lines[i++]);
        const cite = i < lines.length ? lines[i].slice(3).trim() : "";
        const block = el("blockquote", {}, renderWiki(quote.join("\n"), ctx));
        if (cite) {
          const footer = el("cite");
          wikiInline(footer, cite, ctx);
          block.append(footer);
        }
        root.append(block);
        i += 1;
        continue;
      }
      if ((m = /^(!{1,6})\s*(.*)$/.exec(line))) {
        flush();
        const h = el("h" + Math.min(m[1].length + 1, 6));
        wikiInline(h, m[2], ctx);
        root.append(h);
        i += 1;
        continue;
      }
      if (/^-{3,}\s*$/.test(line)) {
        flush();
        root.append(el("hr"));
        i += 1;
        continue;
      }
      if (/^[*#]+\s/.test(line)) {
        flush();
        const items = [];
        while (i < lines.length && (m = /^([*#]+)\s+(.*)$/.exec(lines[i]))) {
          items.push({ marker: m[1], text: m[2] });
          i += 1;
        }
        root.append(buildList(items, wikiInline, ctx));
        continue;
      }
      if (/^[;:]\s?/.test(line)) {
        flush();
        const dl = el("dl");
        while (i < lines.length && (m = /^([;:])\s?(.*)$/.exec(lines[i]))) {
          const node = el(m[1] === ";" ? "dt" : "dd");
          wikiInline(node, m[2], ctx);
          dl.append(node);
          i += 1;
        }
        root.append(dl);
        continue;
      }
      if (/^>\s?/.test(line)) {
        flush();
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
        root.append(el("blockquote", {}, renderWiki(quote.join("\n"), ctx)));
        continue;
      }
      if (/^\|.*\|\s*$/.test(line)) {
        flush();
        const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        root.append(tableNode(rows, ctx));
        continue;
      }
      if ((m = /^\{\{([^{}]+)\}\}\s*$/.exec(line))) {
        flush();
        root.append(transclude(ctx, m[1], true));
        i += 1;
        continue;
      }
      if ((m = /^<<([\w-]+)((?:[^>]|>(?!>))*)>>\s*$/.exec(line))) {
        flush();
        root.append(macroNode(ctx, m[1], m[2] || ""));
        i += 1;
        continue;
      }
      if (line.trim() === "") {
        flush();
        i += 1;
        continue;
      }
      para.push(line);
      i += 1;
    }
    flush();
    return root;
  }

  const MD_INLINE = new RegExp([
    "\\[!\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)\\]\\(([^)\\s]+)\\)",
    "`([^`\\n]+)`",
    "\\[\\[([^\\]\\n]+?)\\]\\]",
    "!\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)",
    "\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)",
    "\\{\\{([^{}\\n]+)\\}\\}",
    "\\*\\*(.+?)\\*\\*",
    "__(.+?)__",
    "\\*([^*\\n]+)\\*",
    "\\b_([^_\\n]+)_\\b",
    "~~(.+?)~~",
    "(https?://[^\\s<>\"']+)",
    "(\\n)",
  ].join("|"), "g");

  function mdInline(parent, text, ctx) {
    const source = String(text);
    const pattern = new RegExp(MD_INLINE.source, "g");
    let last = 0;
    let m;
    while ((m = pattern.exec(source))) {
      if (m.index > last) parent.append(source.slice(last, m.index));
      last = m.index + m[0].length;
      // [![alt](web copy)](original): the picture opens the original on click.
      if (m[1] !== undefined) parent.append(imageNode(m[2], m[1], "", m[3]));
      else if (m[4] !== undefined) parent.append(el("code", {}, m[4]));
      else if (m[5] !== undefined) {
        const bar = m[5].indexOf("|");
        const label = bar >= 0 ? m[5].slice(0, bar) : m[5];
        parent.append(linkNode(ctx, label.trim(), bar >= 0 ? m[5].slice(bar + 1) : m[5]));
      } else if (m[7] !== undefined) parent.append(imageNode(m[7], m[6], ""));
      else if (m[9] !== undefined) {
        const node = linkNode(ctx, "", decodeURIComponentSafe(m[9]));
        node.textContent = "";
        mdInline(node, m[8], ctx);
        parent.append(node);
      } else if (m[10] !== undefined) parent.append(transclude(ctx, m[10], false));
      else if (m[16] !== undefined) {
        const [url, tail] = trimUrl(m[16]);
        parent.append(externalLink(url, url));
        if (tail) parent.append(tail);
      } else if (m[17] !== undefined) parent.append(el("br"));
      else {
        const tags = { 11: "strong", 12: "strong", 13: "em", 14: "em", 15: "s" };
        for (let group = 11; group <= 15; group += 1) {
          if (m[group] !== undefined) {
            const node = el(tags[group]);
            mdInline(node, m[group], ctx);
            parent.append(node);
            break;
          }
        }
      }
    }
    if (last < source.length) parent.append(source.slice(last));
  }

  function decodeURIComponentSafe(value) {
    try { return decodeURIComponent(value); } catch (error) { return value; }
  }

  function renderMarkdown(source, ctx) {
    const root = document.createDocumentFragment();
    const lines = String(source).replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el("p");
      mdInline(p, para.join("\n"), ctx);
      root.append(p);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (/^```/.test(line)) {
        flush();
        const code = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
        root.append(el("pre", {}, el("code", {}, code.join("\n"))));
        i += 1;
        continue;
      }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flush();
        const h = el("h" + Math.min(m[1].length + 1, 6));
        mdInline(h, m[2].replace(/\s+#+\s*$/, ""), ctx);
        root.append(h);
        i += 1;
        continue;
      }
      if (/^(\*\s*\*\s*\*|-\s*-\s*-|_\s*_\s*_)[\s*_-]*$/.test(line)) {
        flush();
        root.append(el("hr"));
        i += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        flush();
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
        root.append(el("blockquote", {}, renderMarkdown(quote.join("\n"), ctx)));
        continue;
      }
      if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
        flush();
        const items = [];
        while (i < lines.length && (m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]))) {
          const level = Math.floor(m[1].replace(/\t/g, "  ").length / 2);
          const ch = /\d/.test(m[2]) ? "#" : "*";
          items.push({ level, ch, text: m[3] });
          i += 1;
        }
        const markers = [];
        root.append(buildList(items.map((item) => {
          markers.length = Math.min(markers.length, item.level);
          while (markers.length < item.level) markers.push("*");
          markers[item.level] = item.ch;
          return { marker: markers.slice(0, item.level + 1).join(""), text: item.text };
        }), mdInline, ctx));
        continue;
      }
      if (/^\|.*\|\s*$/.test(line)) {
        flush();
        const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        const table = el("table");
        const body = el("tbody");
        let headerDone = false;
        rows.forEach((row, index) => {
          if (/^\|[\s:|-]+\|\s*$/.test(row)) return;
          const header = index === 0 && rows[1] && /^\|[\s:|-]+\|\s*$/.test(rows[1]) && !headerDone;
          if (header) headerDone = true;
          const tr = el("tr");
          row.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").forEach((cell) => {
            const td = el(header ? "th" : "td");
            mdInline(td, cell.trim(), ctx);
            tr.append(td);
          });
          body.append(tr);
        });
        table.append(body);
        root.append(el("div", { class: "table-wrap" }, table));
        continue;
      }
      if ((m = /^\{\{([^{}]+)\}\}\s*$/.exec(line))) {
        flush();
        root.append(transclude(ctx, m[1], true));
        i += 1;
        continue;
      }
      if (line.trim() === "") {
        flush();
        i += 1;
        continue;
      }
      para.push(line);
      i += 1;
    }
    flush();
    return root;
  }

  function render(text, type, ctx, inlineOnly) {
    const source = String(text || "");
    if (type === "text/plain") return el("div", { class: "plain" }, source);
    if (type === "text/markdown") return renderMarkdown(source, ctx);
    return renderWiki(source, ctx, inlineOnly);
  }

  // Titles this text points at, for backlinks and the missing list.
  function links(text, type) {
    const found = new Set();
    const source = String(text || "");
    if (type === "text/plain") return found;
    const stripped = source.replace(/```[\s\S]*?```/g, "").replace(/``[\s\S]*?``/g, "").replace(/`[^`\n]*`/g, "");
    let m;
    const linkRe = /\[\[([^\]\n]+?)\]\]/g;
    while ((m = linkRe.exec(stripped))) {
      const bar = m[1].indexOf("|");
      const target = (bar >= 0 ? m[1].slice(bar + 1) : m[1]).trim();
      if (target && !isExternal(target)) found.add(target);
    }
    const transRe = /\{\{([^{}\n]+)\}\}/g;
    while ((m = transRe.exec(stripped))) {
      const target = m[1].split("||")[0].split("!!")[0].trim();
      if (target) found.add(target);
    }
    if (type === "text/markdown") {
      const mdRe = /(?:^|[^!])\[[^\]\n]+\]\(([^)\s]+)\)/g;
      while ((m = mdRe.exec(stripped))) {
        const target = decodeURIComponentSafe(m[1]);
        if (!isExternal(target) && !/^[a-z]+:/i.test(target)) found.add(target);
      }
    }
    return found;
  }

  window.WikiText = { render, links, tasks, setTask };
})();
