(function () {
  const config = window.WIKI_CONFIG || {};
  const I18n = window.WikiI18n;
  const t = I18n.t;
  const root = document.getElementById("root");
  const DEFAULT_TYPE = "text/vnd.tiddlywiki";
  const TYPES = [
    [DEFAULT_TYPE, t("Вики-разметка")],
    ["text/markdown", "Markdown"],
    ["text/plain", t("Простой текст")],
  ];
  const SYNC_MS = 15 * 60 * 1000;

  // Built-in tiddlers. A saved tiddler with the same title replaces one, and
  // deleting that tiddler brings the built-in text back, as in TiddlyWiki.
  const SHADOWS = {
    "$:/SiteTitle": t("Вики"),
    "$:/SiteSubtitle": t("заметки, которые ссылаются друг на друга"),
    "$:/DefaultTiddlers": "[[$:/Markup]]",
    "$:/Markup": I18n.help(),
  };

  const state = {
    email: "",
    tiddlers: new Map(),
    story: [],
    drafts: new Map(),
    history: new Map(),
    tab: "recent",
    query: "",
    showSystem: false,
    loadedAt: 0,
  };
  let pool = null;
  let toastTimer = null;
  let syncTimer = null;
  let linkIndex = null;
  const DRAFT_DELAY = 1500;
  const STORY_DELAY = 1000;
  const draftTimers = new Map();
  const draftStatus = new Map();
  let storyTimer = null;

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value == null || value === false) return;
      if (key === "class") node.className = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (key === "value") node.value = value;
      else node.setAttribute(key, value === true ? "" : value);
    });
    [].concat(children || []).forEach((child) => {
      if (child == null || child === false) return;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function icon(name) {
    const paths = {
      edit: "M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4",
      close: "M6 6l12 12M18 6 6 18",
      link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
      history: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2",
      trash: "M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12",
      plus: "M12 5v14M5 12h14",
      check: "M5 12.5 10 17l9-10",
      file: "M14 4H7a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8l-4-4Zm0 0v4h4",
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[name]);
    svg.append(path);
    return svg;
  }

  function present(...nodes) {
    return nodes.filter((node) => node != null && node !== false);
  }

  function iconButton(name, label, onclick, extraClass) {
    return el("button", { type: "button", class: "icon-button " + (extraClass || ""), title: label, "aria-label": label, onclick }, icon(name));
  }

  function toast(message) {
    let node = document.querySelector(".toast");
    if (!node) {
      node = el("div", { class: "toast", role: "status" });
      document.body.append(node);
    }
    node.textContent = message;
    node.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.add("hidden"), 4200);
  }

  // Auth ---------------------------------------------------------------

  function authMessage(error) {
    const code = error && (error.code || error.name);
    if (code === "NotAuthorizedException" || code === "UserNotFoundException") return t("Неверная почта или пароль");
    if (code === "InvalidPasswordException") return t("Пароль должен быть от 8 символов и содержать строчную букву и цифру");
    return (error && error.message) || t("Не получилось");
  }

  function userPool() {
    if (!pool) {
      pool = new window.AmazonCognitoIdentity.CognitoUserPool({
        UserPoolId: config.userPoolId,
        ClientId: config.clientId,
      });
    }
    return pool;
  }

  function currentSession() {
    return new Promise((resolve, reject) => {
      const user = userPool().getCurrentUser();
      if (!user) return reject(new Error("auth"));
      user.getSession((error, session) => {
        if (error || !session || !session.isValid()) reject(error || new Error("auth"));
        else resolve(session);
      });
    });
  }

  // A saved session keeps the groups it was issued with for up to an hour.
  // Fresh tokens from the refresh token carry the current groups, so a new
  // administrator gets the admin settings without signing out.
  function freshSession() {
    return currentSession().then((session) => new Promise((resolve) => {
      const user = userPool().getCurrentUser();
      if (!user) return resolve(session);
      user.refreshSession(session.getRefreshToken(), (error, fresh) => resolve(error || !fresh ? session : fresh));
    }));
  }

  function applySession(session) {
    const payload = session.getIdToken().payload;
    state.email = payload.email || "";
    state.admin = [].concat(payload["cognito:groups"] || []).includes("admins");
  }

  function sessionExpired() {
    const error = new Error(t("Сессия закончилась"));
    error.session = true;
    return error;
  }

  async function api(path, options) {
    const session = await currentSession();
    const token = session.getIdToken().getJwtToken();
    const response = await fetch(config.apiBase + path, {
      method: (options && options.method) || "GET",
      headers: {
        Authorization: "Bearer " + token,
        "X-Wiki-Lang": I18n.lang,
        ...(options && options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options && options.body ? JSON.stringify(options.body) : undefined,
      keepalive: !!(options && options.keepalive),
    });
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch (error) { data = { error: text }; }
    }
    if (response.status === 401) {
      signOut();
      throw sessionExpired();
    }
    if (!response.ok) {
      const error = new Error(data.error || t("Запрос не выполнен"));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function languagePicker() {
    return el("select", {
      class: "lang-select",
      "aria-label": t("Язык"),
      onchange: (event) => switchLanguage(event.target.value),
    }, I18n.languages.map(([code, name]) => el("option", { value: code, selected: code === I18n.lang }, name)));
  }

  // Everything on the page is built in the chosen language, so switching
  // reloads it; unsaved edits go to the draft store first.
  function switchLanguage(code) {
    if (code === I18n.lang) return;
    if (typeof flushAutosave === "function") flushAutosave();
    I18n.setLang(code);
    window.location.reload();
  }

  function showLogin(message) {
    const error = el("p", { class: "error", role: "alert" }, message || "");
    const demo = config.demo || {};
    const email = el("input", { type: "email", autocomplete: "username", required: true, value: demo.email || "" });
    const password = el("input", { type: "password", autocomplete: "current-password", required: true, value: demo.password || "" });
    root.replaceChildren(el("main", { class: "login" }, [
      el("section", { class: "login-card" }, [
        el("img", { class: "login-mark", src: "/favicon.svg", alt: "" }),
        el("h1", {}, t("Вики")),
        el("p", { class: "lede" }, t("Вход только для приглашённых. Регистрации нет.")),
        demo.email ? el("p", { class: "demo-note" }, [
          t("Демо: {email} / {password}.", { email: demo.email, password: demo.password }),
          demo.reset ? " " + t("Все данные и пользователи стираются каждый час.") : "",
        ]) : null,
        el("form", {
          onsubmit: (event) => {
            event.preventDefault();
            signIn(email.value.trim(), password.value, error);
          },
        }, [
          el("label", {}, [t("Почта"), email]),
          el("label", {}, [t("Пароль"), password]),
          el("button", { class: "primary", type: "submit" }, t("Войти")),
          error,
        ]),
        el("div", { class: "login-lang" }, languagePicker()),
      ]),
    ]));
    email.focus();
  }

  function showNewPassword(user, message) {
    const error = el("p", { class: "error", role: "alert" }, message || "");
    const password = el("input", { type: "password", autocomplete: "new-password", required: true, minlength: "12" });
    root.replaceChildren(el("main", { class: "login" }, [
      el("section", { class: "login-card" }, [
        el("h1", {}, t("Новый пароль")),
        el("p", { class: "lede" }, t("Временный пароль нужно сменить перед входом.")),
        el("form", {
          onsubmit: (event) => {
            event.preventDefault();
            user.completeNewPasswordChallenge(password.value, {}, {
              onSuccess: () => boot(),
              onFailure: (err) => { error.textContent = authMessage(err); },
            });
          },
        }, [
          el("label", {}, [t("Новый пароль"), password]),
          el("button", { class: "primary", type: "submit" }, t("Сохранить и войти")),
          error,
        ]),
      ]),
    ]));
    password.focus();
  }

  function signIn(email, password, errorNode) {
    const user = new window.AmazonCognitoIdentity.CognitoUser({ Username: email, Pool: userPool() });
    user.authenticateUser(new window.AmazonCognitoIdentity.AuthenticationDetails({
      Username: email,
      Password: password,
    }), {
      onSuccess: () => boot(),
      onFailure: (error) => { errorNode.textContent = authMessage(error); },
      newPasswordRequired: () => showNewPassword(user),
    });
  }

  function signOut() {
    const user = pool && pool.getCurrentUser();
    if (user) user.signOut();
    clearInterval(syncTimer);
    stopAutosave();
    state.drafts.clear();
    showLogin();
  }

  function changePassword(oldPassword, newPassword) {
    return new Promise((resolve, reject) => {
      const user = userPool().getCurrentUser();
      if (!user) return reject(sessionExpired());
      user.getSession((sessionError) => {
        if (sessionError) return reject(sessionError);
        user.changePassword(oldPassword, newPassword, (changeError) => {
          if (changeError) reject(changeError);
          else resolve();
        });
      });
    });
  }

  // Store --------------------------------------------------------------

  function isSystem(title) {
    return title.startsWith("$:/");
  }

  function getTiddler(title) {
    const stored = state.tiddlers.get(title);
    if (stored) return stored;
    if (Object.prototype.hasOwnProperty.call(SHADOWS, title)) {
      return { title, text: SHADOWS[title], tags: [], type: DEFAULT_TYPE, shadow: true, etag: "" };
    }
    return null;
  }

  function exists(title) {
    return !!getTiddler(title);
  }

  function allTitles(includeSystem) {
    const titles = new Set(state.tiddlers.keys());
    if (includeSystem) Object.keys(SHADOWS).forEach((title) => titles.add(title));
    return [...titles].filter((title) => includeSystem || !isSystem(title)).sort(compareTitles);
  }

  function compareTitles(a, b) {
    return a.localeCompare(b, "ru", { numeric: true, sensitivity: "base" });
  }

  function tagged(tag) {
    return [...state.tiddlers.values()]
      .filter((tiddler) => tiddler.tags.includes(tag))
      .map((tiddler) => tiddler.title)
      .sort(compareTitles);
  }

  function recent(count) {
    return [...state.tiddlers.values()]
      .filter((tiddler) => !isSystem(tiddler.title))
      .sort((a, b) => (b.modified || "").localeCompare(a.modified || ""))
      .slice(0, count)
      .map((tiddler) => tiddler.title);
  }

  function links() {
    if (!linkIndex) {
      linkIndex = new Map();
      state.tiddlers.forEach((tiddler) => linkIndex.set(tiddler.title, new Set(tiddler.links || [])));
    }
    return linkIndex;
  }

  function backlinks(title) {
    const result = [];
    links().forEach((targets, from) => {
      if (from !== title && targets.has(title)) result.push(from);
    });
    return result.sort(compareTitles);
  }

  function missingTitles() {
    const missing = new Map();
    links().forEach((targets, from) => {
      targets.forEach((target) => {
        if (exists(target)) return;
        if (!missing.has(target)) missing.set(target, []);
        missing.get(target).push(from);
      });
    });
    return [...missing.keys()].sort(compareTitles);
  }

  function allTags() {
    const counts = new Map();
    state.tiddlers.forEach((tiddler) => tiddler.tags.forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
    return [...counts.entries()].sort((a, b) => compareTitles(a[0], b[0]));
  }

  function setTiddler(tiddler) {
    state.tiddlers.set(tiddler.title, tiddler);
    linkIndex = null;
  }

  function removeTiddler(title) {
    state.tiddlers.delete(title);
    linkIndex = null;
  }

  // The list has every tiddler but no text. A text is loaded when its
  // tiddler is shown, and kept while its etag stays the same.
  async function loadAll() {
    const next = new Map();
    let cursor = null;
    do {
      const page = await api("/tiddlers" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
      page.items.forEach((meta) => {
        const known = state.tiddlers.get(meta.title);
        const keep = known && known.etag === meta.etag && typeof known.text === "string";
        next.set(meta.title, keep ? Object.assign({}, meta, { text: known.text }) : meta);
      });
      cursor = page.next_cursor;
    } while (cursor);
    state.tiddlers = next;
    state.loadedAt = Date.now();
    linkIndex = null;
  }

  function hasText(title) {
    const tiddler = state.tiddlers.get(title);
    return !tiddler || typeof tiddler.text === "string";
  }

  const textRequests = new Map();

  // Loads the texts of these tiddlers, 100 per request, and waits for any
  // that are already on their way.
  function loadTexts(titles) {
    const waiting = [];
    const wanted = [];
    [...new Set(titles)].forEach((title) => {
      if (hasText(title)) return;
      if (textRequests.has(title)) waiting.push(textRequests.get(title));
      else wanted.push(title);
    });
    for (let start = 0; start < wanted.length; start += 100) {
      const chunk = wanted.slice(start, start + 100);
      const request = api("/tiddlers/get", { method: "POST", body: { titles: chunk } }).then((data) => {
        data.items.forEach((item) => {
          const known = state.tiddlers.get(item.title);
          if (!known || known.etag === item.etag || typeof known.text !== "string") setTiddler(item);
        });
        // A tiddler missing from the answer was deleted meanwhile; without
        // this it would be asked for again on every redraw.
        const got = new Set(data.items.map((item) => item.title));
        chunk.forEach((title) => {
          if (!got.has(title)) removeTiddler(title);
        });
      });
      chunk.forEach((title) => textRequests.set(title, request));
      waiting.push(request.finally(() => chunk.forEach((title) => textRequests.delete(title))));
    }
    return Promise.all(waiting);
  }

  // Rendering asks for texts it does not have; asks made in one pass go out
  // as one request, then the open cards are drawn again.
  let textWants = new Set();
  let textWantTimer = null;

  function requestText(title) {
    if (hasText(title) || textRequests.has(title)) return;
    textWants.add(title);
    if (textWantTimer) return;
    textWantTimer = setTimeout(() => {
      const titles = [...textWants];
      textWants = new Set();
      textWantTimer = null;
      loadTexts(titles).then(refreshViews, (error) => toast(t("Не удалось загрузить: {error}", { error: error.message })));
    }, 0);
  }

  async function sync() {
    try {
      await loadAll();
      forgetTasks();
      renderSidebar();
      state.story.forEach((title) => {
        if (!state.drafts.has(title)) replaceCard(title);
      });
      applySiteTitle();
    } catch (error) {
      if (!error.session) toast(t("Не удалось обновить список: {error}", { error: error.message }));
    }
  }

  // Rendering ----------------------------------------------------------

  // Only a saved tiddler shown in its card has live task boxes; previews,
  // old revisions and built-in tiddlers show them read-only.
  function renderContext(title, interactive) {
    return {
      exists,
      get: getTiddler,
      tagged,
      recent,
      allTasks,
      need: requestText,
      current: title,
      stack: [title],
      interactive: !!interactive,
      taskCounter: { n: 0 },
    };
  }

  function renderText(tiddler, interactive) {
    const node = el("div", { class: "body" });
    if (typeof tiddler.text !== "string") {
      requestText(tiddler.title);
      node.append(el("p", { class: "muted" }, t("Загружаю…")));
    } else if (!tiddler.text.trim()) {
      node.append(el("p", { class: "muted" }, t("Текста нет")));
    } else {
      const live = interactive && state.tiddlers.has(tiddler.title);
      node.append(window.WikiText.render(tiddler.text, tiddler.type, renderContext(tiddler.title, live)));
    }
    return node;
  }

  // Tasks --------------------------------------------------------------

  // <<todo>> needs every text, so the server gathers the open tasks. The
  // answer is kept until something is saved or the list is refreshed.
  const taskGroups = new Map();

  function allTasks(tag) {
    const key = tag || "";
    const entry = taskGroups.get(key);
    if (entry) return entry.items;
    taskGroups.set(key, { items: null });
    api("/tasks" + (tag ? "?tag=" + encodeURIComponent(tag) : "")).then((data) => {
      taskGroups.set(key, { items: data.items });
      refreshViews();
    }, () => taskGroups.delete(key));
    return null;
  }

  function forgetTasks() {
    taskGroups.clear();
  }

  function taskCount(tiddler) {
    if (typeof tiddler.text !== "string") return null;
    const list = window.WikiText.tasks(tiddler.text, tiddler.type);
    if (!list.length) return null;
    const done = list.filter((task) => task.done).length;
    return el("span", { class: done === list.length ? "task-count all" : "task-count" }, t("задачи: {done} из {total}", { done, total: list.length }));
  }

  const taskSaves = new Map();
  const taskSaved = new Map();

  // Cards being edited keep their editor; only an open preview in them is
  // drawn again, so a text or task list that arrived late shows up there too.
  function refreshViews() {
    state.story.forEach((title) => {
      if (!state.drafts.has(title)) replaceCard(title);
    });
    document.querySelectorAll(".tiddler.editing .preview:not(.hidden)").forEach((box) => {
      if (box.redraw) box.redraw();
    });
  }

  // A click changes the text at once; saves for one tiddler run one after
  // another, each sending the latest text with the latest etag.
  async function toggleTask(title, index, done) {
    if (!hasText(title)) await loadTexts([title]);
    const tiddler = state.tiddlers.get(title);
    if (!tiddler) return;
    const text = window.WikiText.setTask(tiddler.text, tiddler.type, index, done);
    if (text === null) {
      toast(t("Задача не найдена, обновите страницу"));
      refreshViews();
      return;
    }
    setTiddler(Object.assign({}, tiddler, { text }));
    taskGroups.forEach((entry) => (entry.items || []).forEach((group) => {
      if (group.title === title) group.tasks = group.tasks.filter((task) => task.index !== index || !done);
    }));
    refreshViews();
    const chain = (taskSaves.get(title) || Promise.resolve()).then(() => saveTaskText(title));
    taskSaves.set(title, chain);
    chain.finally(() => {
      if (taskSaves.get(title) === chain) taskSaves.delete(title);
    });
  }

  async function saveTaskText(title) {
    const local = state.tiddlers.get(title);
    if (!local || taskSaved.get(title) === local.text) return;
    try {
      const saved = await api("/tiddler", {
        method: "PUT",
        body: { title, text: local.text, tags: local.tags, type: local.type, etag: local.etag },
      });
      taskSaved.set(title, saved.text);
      const now = state.tiddlers.get(title);
      setTiddler(Object.assign({}, saved, { text: now ? now.text : saved.text }));
      forgetTasks();
      refreshViews();
      renderSidebarList();
    } catch (error) {
      taskSaved.delete(title);
      toast(t("Отметка не сохранилась: {error}", { error: error.message }));
      await sync();
    }
  }

  function siteTitle() {
    return (getTiddler("$:/SiteTitle").text || t("Вики")).trim();
  }

  function applySiteTitle() {
    document.title = siteTitle();
    const heading = document.querySelector(".site-title");
    if (heading) heading.textContent = siteTitle();
    const subtitle = document.querySelector(".site-subtitle");
    if (subtitle) subtitle.textContent = (getTiddler("$:/SiteSubtitle").text || "").trim();
  }

  function renderApp() {
    root.replaceChildren(el("div", { class: "layout" }, [
      el("main", { class: "story", id: "story", "aria-label": t("Открытые тиддлеры") }),
      el("aside", { class: "sidebar", id: "sidebar" }),
    ]));
    renderSidebar();
    renderStory();
    applySiteTitle();
  }

  function renderSidebar() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    const search = el("input", {
      type: "search",
      class: "search",
      placeholder: t("Поиск"),
      "aria-label": t("Поиск по тиддлерам"),
      value: state.query,
      oninput: (event) => {
        state.query = event.target.value;
        renderSidebarList();
        scheduleSearch();
      },
      onkeydown: (event) => {
        if (event.key === "Enter") {
          const first = searchResults(state.query)[0];
          if (first) openTiddler(first);
        }
      },
    });
    const tabs = [["recent", t("Недавние")], ["all", t("Все")], ["tags", t("Теги")], ["missing", t("Нет текста")]];
    sidebar.replaceChildren(
      el("header", { class: "site" }, [
        el("h1", { class: "site-title" }, siteTitle()),
        el("p", { class: "site-subtitle" }, (getTiddler("$:/SiteSubtitle").text || "").trim()),
      ]),
      el("div", { class: "actions" }, [
        el("button", { type: "button", class: "primary", onclick: () => newTiddler() }, [icon("plus"), t("Новый тиддлер")]),
        el("button", { type: "button", onclick: closeAll, disabled: !state.story.length }, t("Закрыть все")),
      ]),
      search,
      el("div", { class: "tabs", role: "tablist" }, tabs.map(([key, label]) => el("button", {
        type: "button",
        role: "tab",
        "data-tab": key,
        "aria-selected": String(state.tab === key && !state.query),
        class: state.tab === key && !state.query ? "tab active" : "tab",
        onclick: () => {
          state.tab = key;
          state.query = "";
          renderSidebar();
        },
      }, label))),
      el("div", { class: "side-list", id: "side-list" }),
      el("footer", { class: "account" }, [
        el("span", { class: "who", title: state.email }, state.email),
        el("button", { type: "button", class: "link-button", onclick: () => showSettings() }, t("Настройки")),
        el("button", { type: "button", class: "link-button", onclick: signOut }, t("Выйти")),
      ]),
    );
    renderSidebarList();
  }

  function titleButton(title, note) {
    return el("li", {}, [
      el("a", {
        class: exists(title) ? "link" : "link missing",
        href: "#" + encodeURIComponent(title),
        "data-title": title,
      }, title),
      note ? el("span", { class: "note" }, note) : null,
    ]);
  }

  // Titles, tags and texts already here are searched at once; the server
  // searches every text a moment after typing stops.
  const SEARCH_DELAY = 300;
  const serverSearch = { query: "", items: null };
  let searchTimer = null;

  function scheduleSearch() {
    clearTimeout(searchTimer);
    const query = state.query.trim();
    if (!query) return;
    searchTimer = setTimeout(async () => {
      serverSearch.query = query;
      serverSearch.items = null;
      renderSidebarList();
      let items = [];
      try {
        items = (await api("/search?q=" + encodeURIComponent(query))).items;
      } catch (error) {
        toast(error.message);
      }
      if (serverSearch.query !== query) return;
      serverSearch.items = items;
      renderSidebarList();
    }, SEARCH_DELAY);
  }

  function searchResults(query) {
    const words = query.toLocaleLowerCase("ru").replace(/ё/g, "е").split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const fold = (text) => String(text || "").toLocaleLowerCase("ru").replace(/ё/g, "е");
    const inTitle = [];
    const inText = [];
    allTitles(true).forEach((title) => {
      const tiddler = getTiddler(title);
      const name = fold(title);
      const body = name + " " + fold(tiddler.tags.join(" ")) + " " + fold(tiddler.text);
      if (!words.every((word) => body.includes(word))) return;
      (words.every((word) => name.includes(word)) ? inTitle : inText).push(title);
    });
    const found = inTitle.concat(inText);
    if (serverSearch.query === query.trim() && serverSearch.items) {
      serverSearch.items.forEach((title) => {
        if (state.tiddlers.has(title) && !found.includes(title)) found.push(title);
      });
    }
    return found;
  }

  function renderSidebarList() {
    const list = document.getElementById("side-list");
    if (!list) return;
    document.querySelectorAll(".tabs .tab").forEach((tab) => {
      const active = !state.query && tab.dataset.tab === state.tab;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    if (state.query.trim()) {
      const results = searchResults(state.query);
      const searching = serverSearch.query !== state.query.trim() || !serverSearch.items;
      list.replaceChildren(
        el("p", { class: "count" }, [
          results.length ? t("Найдено: {count}", { count: results.length }) : searching ? "" : t("Ничего не нашлось"),
          searching ? el("span", { class: "muted" }, (results.length ? " " : "") + t("Ищу в тексте статей…")) : null,
        ]),
        el("ul", { class: "titles" }, results.slice(0, 200).map((title) => titleButton(title))),
      );
      return;
    }
    if (state.tab === "recent") {
      const groups = new Map();
      recent(60).forEach((title) => {
        const day = formatDay(state.tiddlers.get(title).modified);
        if (!groups.has(day)) groups.set(day, []);
        groups.get(day).push(title);
      });
      if (!groups.size) {
        list.replaceChildren(el("p", { class: "count" }, t("Пока пусто. Создайте первый тиддлер.")));
        return;
      }
      list.replaceChildren(...[...groups.entries()].map(([day, titles]) => el("section", { class: "day" }, [
        el("h2", {}, day),
        el("ul", { class: "titles" }, titles.map((title) => titleButton(title))),
      ])));
      return;
    }
    if (state.tab === "all") {
      const titles = allTitles(state.showSystem);
      list.replaceChildren(
        el("label", { class: "check" }, [
          el("input", {
            type: "checkbox",
            checked: state.showSystem,
            onchange: (event) => {
              state.showSystem = event.target.checked;
              renderSidebarList();
            },
          }),
          t("Показывать системные $:/"),
        ]),
        el("ul", { class: "titles" }, titles.map((title) => titleButton(title))),
      );
      return;
    }
    if (state.tab === "tags") {
      const tags = allTags();
      list.replaceChildren(tags.length
        ? el("div", { class: "tag-cloud" }, tags.map(([tag, count]) => tagPill(tag, count)))
        : el("p", { class: "count" }, t("Тегов пока нет")));
      return;
    }
    const missing = missingTitles();
    list.replaceChildren(
      el("p", { class: "count" }, missing.length ? t("На эти названия есть ссылки, а текста ещё нет.") : t("Все ссылки ведут на существующие тиддлеры.")),
      el("ul", { class: "titles" }, missing.map((title) => titleButton(title))),
    );
  }

  function tagPill(tag, count) {
    return el("a", {
      class: exists(tag) ? "tag" : "tag missing",
      href: "#" + encodeURIComponent(tag),
      "data-title": tag,
    }, count ? [tag, el("span", { class: "tag-count" }, String(count))] : tag);
  }

  function renderStory() {
    const story = document.getElementById("story");
    if (!story) return;
    if (!state.story.length) {
      story.replaceChildren(el("div", { class: "empty-story" }, [
        el("p", {}, t("Все тиддлеры закрыты.")),
        el("p", {}, t("Откройте что-нибудь из списка справа или создайте новый.")),
      ]));
      return;
    }
    story.replaceChildren(...state.story.map((title) => cardNode(title)));
  }

  function cardId(title) {
    return "t-" + Array.from(title).map((ch) => ch.codePointAt(0).toString(36)).join("-");
  }

  function replaceCard(title) {
    const old = document.getElementById(cardId(title));
    if (old) old.replaceWith(cardNode(title));
  }

  function cardNode(title) {
    if (state.drafts.has(title)) return editorNode(title);
    const tiddler = getTiddler(title);
    const node = el("article", { class: "tiddler", id: cardId(title), "data-card": title, tabindex: "-1" });
    if (!tiddler) {
      node.classList.add("is-missing");
      node.append(...present(
        el("header", { class: "card-head" }, [
          el("h2", { class: "card-title" }, title),
          el("div", { class: "toolbar" }, [
            iconButton("edit", t("Создать"), () => startEdit(title)),
            iconButton("close", t("Закрыть"), () => closeTiddler(title)),
          ]),
        ]),
        el("div", { class: "body" }, [
          el("p", { class: "muted" }, t("Такого тиддлера пока нет.")),
          el("button", { type: "button", class: "primary", onclick: () => startEdit(title) }, t("Написать текст")),
        ]),
        footerNode(title),
      ));
      return node;
    }
    const meta = tiddler.shadow
      ? t("встроенный тиддлер, правка создаст свою копию")
      : [tiddler.modifier, formatWhen(tiddler.modified)].filter(Boolean).join(", ");
    node.append(...present(
      el("header", { class: "card-head" }, [
        el("h2", { class: "card-title" }, title),
        el("div", { class: "toolbar" }, [
          iconButton("edit", t("Править"), () => startEdit(title)),
          iconButton("link", t("Скопировать ссылку"), () => copyLink(title)),
          tiddler.shadow ? null : iconButton("history", t("История"), () => toggleHistory(title), state.history.has(title) ? "on" : ""),
          iconButton("close", t("Закрыть"), () => closeTiddler(title)),
        ]),
      ]),
      el("p", { class: "card-meta" }, [meta, taskCount(tiddler)]),
      tiddler.tags.length ? el("div", { class: "tags" }, tiddler.tags.map((tag) => tagPill(tag))) : null,
      renderText(tiddler, true),
      historyNode(title),
      footerNode(title),
    ));
    return node;
  }

  function footerNode(title) {
    const children = tagged(title);
    const refs = backlinks(title);
    if (!children.length && !refs.length) return null;
    return el("footer", { class: "card-foot" }, [
      children.length ? el("div", {}, [el("h3", {}, t("С этим тегом")), el("ul", { class: "inline-list" }, children.map((item) => titleButton(item)))]) : null,
      refs.length ? el("div", {}, [el("h3", {}, t("Ссылаются сюда")), el("ul", { class: "inline-list" }, refs.map((item) => titleButton(item)))]) : null,
    ]);
  }

  function historyNode(title) {
    const entry = state.history.get(title);
    if (!entry) return null;
    const box = el("section", { class: "history" }, el("h3", {}, t("История")));
    if (entry.loading) {
      box.append(el("p", { class: "muted" }, t("Загружаю…")));
      return box;
    }
    if (!entry.items.length) {
      box.append(el("p", { class: "muted" }, t("Записей нет")));
      return box;
    }
    const labels = { create: t("создан"), save: t("сохранён"), rename: t("переименован"), delete: t("удалён") };
    const list = el("ol", { class: "revisions" }, entry.items.map((rev, index) => {
      let what = labels[rev.action] || rev.action;
      if (rev.from_title) what = t("переименован из «{title}»", { title: rev.from_title });
      if (rev.to_title) what = t("переименован в «{title}»", { title: rev.to_title });
      return el("li", { class: entry.selected === index ? "selected" : "" }, [
        el("button", {
          type: "button",
          class: "link-button",
          onclick: () => {
            entry.selected = entry.selected === index ? -1 : index;
            replaceCard(title);
          },
        }, formatWhen(rev.at)),
        el("span", {}, " " + what + ", " + (rev.by || "")),
      ]);
    }));
    box.append(list);
    const rev = entry.items[entry.selected];
    if (rev) {
      box.append(el("div", { class: "revision-view" }, [
        el("div", { class: "revision-actions" }, [
          el("button", {
            type: "button",
            onclick: () => startEdit(title, { text: rev.text, tags: rev.tags, type: rev.type }),
          }, t("Открыть эту версию в редакторе")),
        ]),
        rev.tags && rev.tags.length ? el("div", { class: "tags" }, rev.tags.map((tag) => tagPill(tag))) : null,
        renderText(Object.assign({}, rev, { title })),
      ]));
    }
    return box;
  }

  async function toggleHistory(title) {
    if (state.history.has(title)) {
      state.history.delete(title);
      replaceCard(title);
      return;
    }
    const entry = { loading: true, items: [], selected: -1 };
    state.history.set(title, entry);
    replaceCard(title);
    try {
      const data = await api("/revisions?title=" + encodeURIComponent(title));
      entry.items = data.items;
    } catch (error) {
      toast(error.message);
      state.history.delete(title);
    }
    entry.loading = false;
    replaceCard(title);
  }

  // Editing ------------------------------------------------------------

  function uniqueTitle(base) {
    if (!exists(base) && !state.drafts.has(base)) return base;
    let n = 2;
    while (exists(base + " " + n) || state.drafts.has(base + " " + n)) n += 1;
    return base + " " + n;
  }

  function newTiddler() {
    const title = uniqueTitle(t("Новый тиддлер"));
    state.drafts.set(title, { title, text: "", tags: [], type: DEFAULT_TYPE, etag: "", fresh: true });
    placeInStory(title, null, true);
  }

  async function startEdit(title, override) {
    if (!override && !hasText(title)) {
      try {
        await loadTexts([title]);
      } catch (error) {
        toast(t("Не удалось загрузить: {error}", { error: error.message }));
        return;
      }
    }
    const tiddler = getTiddler(title);
    const stored = state.tiddlers.get(title);
    const base = override || tiddler || {};
    state.drafts.set(title, {
      title,
      text: base.text || "",
      tags: [...(base.tags || [])],
      type: base.type || DEFAULT_TYPE,
      etag: stored ? stored.etag : "",
      original: stored ? title : "",
      fresh: !stored,
    });
    state.history.delete(title);
    replaceCard(title);
    focusCard(title, "textarea");
    if (override) queueDraft(title);
  }

  function draftChanged(key) {
    const draft = state.drafts.get(key);
    if (!draft) return false;
    const current = getTiddler(key) || { text: "", tags: [], type: DEFAULT_TYPE };
    return draft.title !== key || draft.text !== (current.text || "") || draft.type !== (current.type || DEFAULT_TYPE)
      || draft.tags.join("\n") !== (current.tags || []).join("\n");
  }

  function cancelEdit(key) {
    if (draftChanged(key) && !window.confirm(t("Отменить правку? Изменения пропадут."))) return;
    const draft = state.drafts.get(key);
    state.drafts.delete(key);
    dropDraft(key, draft);
    if (draft && draft.fresh && !exists(key)) {
      closeTiddler(key);
      return;
    }
    replaceCard(key);
  }

  function tagEditor(draft, onChange) {
    const wrap = el("div", { class: "tag-editor" });
    const input = el("input", {
      type: "text",
      placeholder: t("Добавить тег"),
      "aria-label": t("Добавить тег"),
      list: "tag-suggestions",
      onkeydown: (event) => {
        if ((event.key === "Enter" || event.key === ",") && input.value.trim()) {
          event.preventDefault();
          addTag(input.value);
        } else if (event.key === "Backspace" && !input.value && draft.tags.length) {
          draft.tags.pop();
          draw();
          onChange();
        }
      },
      onchange: () => {
        if (input.value.trim()) addTag(input.value);
      },
    });
    const suggestions = el("datalist", { id: "tag-suggestions" }, allTags().map(([tag]) => el("option", { value: tag })));
    function addTag(value) {
      const tag = value.replace(/,$/, "").trim();
      if (tag && !draft.tags.includes(tag)) draft.tags.push(tag);
      input.value = "";
      draw();
      onChange();
      input.focus();
    }
    function draw() {
      wrap.replaceChildren(...draft.tags.map((tag) => el("span", { class: "tag editable" }, [
        tag,
        el("button", {
          type: "button",
          "aria-label": t("Убрать тег {tag}", { tag }),
          onclick: () => {
            draft.tags = draft.tags.filter((item) => item !== tag);
            draw();
            onChange();
          },
        }, "×"),
      ])), input, suggestions);
    }
    draw();
    return wrap;
  }

  function wrapSelection(area, before, after, placeholder) {
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const selected = area.value.slice(start, end) || placeholder || "";
    area.setRangeText(before + selected + after, start, end, "select");
    area.selectionStart = start + before.length;
    area.selectionEnd = start + before.length + selected.length;
    area.focus();
    area.dispatchEvent(new Event("input"));
  }

  function prefixLines(area, prefix) {
    const value = area.value;
    const start = value.lastIndexOf("\n", area.selectionStart - 1) + 1;
    let end = value.indexOf("\n", area.selectionEnd);
    if (end < 0) end = value.length;
    const block = value.slice(start, end).split("\n").map((line) => prefix + line).join("\n");
    area.setRangeText(block, start, end, "end");
    area.focus();
    area.dispatchEvent(new Event("input"));
  }

  function markup(type) {
    if (type === "text/markdown") {
      return {
        bold: ["**", "**"], italic: ["*", "*"], code: ["`", "`"], heading: "## ", list: "- ", task: "- [ ] ",
        link: ["[[", "]]"],
        image: (name, path, full) => (full ? "[![" + name + "](" + path + ")](" + full + ")" : "![" + name + "](" + path + ")"),
        file: (name, path) => "[" + name + "](" + path + ")",
      };
    }
    return {
      bold: ["''", "''"], italic: ["//", "//"], code: ["`", "`"], heading: "!! ", list: "* ", task: "* [ ] ",
      link: ["[[", "]]"],
      image: (name, path, full) => "[img" + (full ? " full=\"" + full + "\" " : "") + "[" + name.replace(/[[\]|"]/g, "") + "|" + path + "]]",
      file: (name, path) => "[[" + name.replace(/[[\]|]/g, "") + "|" + path + "]]",
    };
  }

  function editorNode(key) {
    const draft = state.drafts.get(key);
    let preview = null;
    const titleInput = el("input", {
      type: "text",
      class: "title-input",
      value: draft.title,
      "aria-label": t("Название"),
      oninput: (event) => {
        draft.title = event.target.value;
        queueDraft(key);
      },
    });
    const area = el("textarea", {
      class: "text-input",
      "aria-label": t("Текст"),
      spellcheck: "true",
      value: draft.text,
      oninput: (event) => {
        draft.text = event.target.value;
        autosize(event.target);
        if (preview) drawPreview();
        queueDraft(key);
      },
      onkeydown: (event) => continueTask(event, area),
      onpaste: (event) => {
        const files = [...(event.clipboardData ? event.clipboardData.files : [])];
        if (files.length) {
          event.preventDefault();
          files.forEach((file) => uploadInto(area, draft, file));
        }
      },
      ondrop: (event) => {
        const files = [...(event.dataTransfer ? event.dataTransfer.files : [])];
        if (files.length) {
          event.preventDefault();
          files.forEach((file) => uploadInto(area, draft, file));
        }
      },
    });
    const typeSelect = el("select", {
      "aria-label": t("Разметка"),
      onchange: (event) => {
        draft.type = event.target.value;
        if (preview) drawPreview();
        queueDraft(key);
      },
    }, TYPES.map(([value, label]) => el("option", { value, selected: draft.type === value }, label)));
    const fileInput = el("input", {
      type: "file",
      multiple: true,
      class: "hidden",
      onchange: (event) => {
        [...event.target.files].forEach((file) => uploadInto(area, draft, file));
        event.target.value = "";
      },
    });
    const m = () => markup(draft.type);
    const previewButton = el("button", { type: "button", class: "tool", "aria-pressed": "false", onclick: togglePreview }, t("Просмотр"));
    const toolbar = el("div", { class: "edit-tools", role: "toolbar", "aria-label": t("Разметка") }, [
      el("button", { type: "button", class: "tool", title: t("Жирный"), onclick: () => wrapSelection(area, ...m().bold, t("текст")) }, el("strong", {}, t("Ж"))),
      el("button", { type: "button", class: "tool", title: t("Курсив"), onclick: () => wrapSelection(area, ...m().italic, t("текст")) }, el("em", {}, t("К"))),
      el("button", { type: "button", class: "tool", title: t("Код"), onclick: () => wrapSelection(area, ...m().code, t("код")) }, "</>"),
      el("button", { type: "button", class: "tool", title: t("Заголовок"), onclick: () => prefixLines(area, m().heading) }, "H"),
      el("button", { type: "button", class: "tool", title: t("Список"), onclick: () => prefixLines(area, m().list) }, "•"),
      el("button", { type: "button", class: "tool", title: t("Задача"), onclick: () => prefixLines(area, m().task) }, "☐"),
      el("button", { type: "button", class: "tool", title: t("Ссылка на тиддлер"), onclick: () => wrapSelection(area, ...m().link, t("Название")) }, "[[ ]]"),
      el("button", { type: "button", class: "tool", title: t("Загрузить файл или картинку"), onclick: () => fileInput.click() }, [icon("file"), t("Файл")]),
      fileInput,
      el("span", { class: "spacer" }),
      typeSelect,
      previewButton,
    ]);
    const previewBox = el("div", { class: "preview hidden", "aria-live": "polite" });
    function drawPreview() {
      previewBox.replaceChildren(renderText({ title: draft.title, text: draft.text, type: draft.type, tags: draft.tags }));
    }
    previewBox.redraw = drawPreview;
    function togglePreview() {
      preview = !preview;
      previewBox.classList.toggle("hidden", !preview);
      previewButton.setAttribute("aria-pressed", String(!!preview));
      if (preview) drawPreview();
    }
    const node = el("article", { class: "tiddler editing", id: cardId(key), "data-card": key, tabindex: "-1" }, [
      el("header", { class: "card-head" }, [
        titleInput,
        el("div", { class: "toolbar" }, [
          draft.fresh ? null : iconButton("trash", t("Удалить"), () => deleteTiddler(key), "danger"),
          iconButton("close", t("Отменить"), () => cancelEdit(key)),
          iconButton("check", t("Сохранить"), () => saveDraft(key), "save"),
        ]),
      ]),
      draftWarning(key, draft),
      tagEditor(draft, () => queueDraft(key)),
      toolbar,
      area,
      previewBox,
      el("p", { class: "autosave", "aria-live": "polite" }, draftStatusText(draftStatus.get(key))),
      el("p", { class: "hint" }, t("Черновик сохраняется сам. Ctrl+Enter — сохранить тиддлер, Esc — отменить правку. Картинку можно вставить из буфера или перетащить.")),
    ]);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveDraft(key);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEdit(key);
      }
    });
    requestAnimationFrame(() => autosize(area));
    return node;
  }

  // Enter on a task line starts the next task; Enter on an empty task ends
  // the list, as in most editors.
  function continueTask(event, area) {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const start = area.selectionStart;
    if (start !== area.selectionEnd) return;
    const lineStart = area.value.lastIndexOf("\n", start - 1) + 1;
    const line = area.value.slice(lineStart, start);
    const m = /^(\s*(?:>\s?)*\s*(?:[*#]+|[-+]|\d+[.)])\s+)\[[ xX]\]\s*/.exec(line);
    if (!m) return;
    event.preventDefault();
    if (!line.slice(m[0].length).trim()) {
      area.setRangeText("", lineStart, start, "end");
    } else {
      const prefix = m[1].replace(/(\d+)([.)])/, (all, n, sign) => (Number(n) + 1) + sign);
      area.setRangeText("\n" + prefix + "[ ] ", start, start, "end");
    }
    area.dispatchEvent(new Event("input"));
  }

  function autosize(area) {
    area.style.height = "auto";
    area.style.height = Math.min(Math.max(area.scrollHeight + 2, 220), window.innerHeight * 0.75) + "px";
  }

  // Photos get a copy sized for a desktop screen; the original is uploaded
  // untouched next to it and opens on click. GIF, SVG and animated WebP keep
  // their animation or vectors, so they go up as they are.
  const WEB_EDGE = 1920;
  const WEB_QUALITY = 0.82;
  const WEB_KEEP_BYTES = 400 * 1024;

  async function isAnimatedWebp(file) {
    if (file.type !== "image/webp") return false;
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    for (let i = 12; i < head.length - 4; i += 1) {
      if (head[i] === 0x41 && head[i + 1] === 0x4e && head[i + 2] === 0x49 && head[i + 3] === 0x4d) return true;
    }
    return false;
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  async function webCopy(file) {
    if (!/^image\/(jpeg|png|webp|bmp)$/.test(file.type) || (await isAnimatedWebp(file))) return null;
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (error) {
      return null;
    }
    const scale = Math.min(1, WEB_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= WEB_KEEP_BYTES) {
      bitmap.close();
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    let blob = await canvasBlob(canvas, "image/webp", WEB_QUALITY);
    if (!blob || blob.type !== "image/webp") {
      // No WebP encoder here. JPEG has no transparency, so a PNG stays as it is.
      if (file.type === "image/png") return null;
      blob = await canvasBlob(canvas, "image/jpeg", WEB_QUALITY);
    }
    if (!blob || blob.size >= file.size) return null;
    const stem = (file.name || "image").replace(/\.[^.]+$/, "");
    return new File([blob], stem + (blob.type === "image/webp" ? ".webp" : ".jpg"), { type: blob.type });
  }

  function postToS3(post, file, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      Object.entries(post.fields).forEach(([key, value]) => form.append(key, value));
      form.append("file", file);
      const request = new XMLHttpRequest();
      request.open("POST", post.url);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
      request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(t("S3 не принял файл"))));
      request.onerror = () => reject(new Error(t("соединение прервалось")));
      request.send(form);
    });
  }

  async function uploadFile(file, onProgress) {
    const signed = await api("/files", {
      method: "POST",
      body: { name: file.name || "file", content_type: file.type || "application/octet-stream", size: file.size },
    });
    await postToS3(signed.post, file, onProgress);
    return signed;
  }

  async function uploadInto(area, draft, file) {
    const name = file.name || "file";
    const placeholder = t("[загружается {name}…]", { name });
    const at = area.selectionStart;
    area.setRangeText(placeholder, at, area.selectionEnd, "end");
    area.dispatchEvent(new Event("input"));
    try {
      const web = await webCopy(file);
      const total = file.size + (web ? web.size : 0);
      let done = 0;
      const progress = (loaded) => {
        const percent = Math.min(99, Math.round(((done + loaded) / total) * 100));
        if (total > 2 * 1024 * 1024) toast(t("Загружается {name}: {percent}%", { name, percent }));
      };
      const original = await uploadFile(file, progress);
      done = file.size;
      const shown = web ? await uploadFile(web, progress) : original;
      const isMedia = /^(image|video)\//.test(original.content_type) || /\.(mp4|m4v|webm|ogv|mov)$/i.test(original.path);
      const text = isMedia
        ? markup(draft.type).image(name, shown.path, web ? original.path : "")
        : markup(draft.type).file(name, original.path);
      replacePlaceholder(area, placeholder, text);
      toast(web
        ? t("Загружено: {web} для страницы, исходник {original}", { web: formatBytes(web.size), original: formatBytes(file.size) })
        : t("Файл загружен"));
    } catch (error) {
      replacePlaceholder(area, placeholder, "");
      toast(t("Файл не загружен: {error}", { error: error.message }));
    }
  }

  function formatBytes(bytes) {
    const number = (value) => value.toLocaleString(I18n.locale, { maximumFractionDigits: 1 });
    if (bytes >= 1024 * 1024) return t("{size} МБ", { size: number(bytes / 1024 / 1024) });
    return t("{size} КБ", { size: number(Math.max(1, Math.round(bytes / 1024))) });
  }

  // Full size view -----------------------------------------------------

  function openImage(img) {
    const full = img.getAttribute("data-full") || img.src;
    const picture = el("img", { src: full, alt: img.alt || "" });
    const wrap = el("div", {
      class: "lightbox",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": img.alt || t("Изображение"),
      onclick: (event) => {
        if (event.target === picture) wrap.classList.toggle("actual");
        else if (!event.target.closest("a")) wrap.remove();
      },
    }, [
      picture,
      el("div", { class: "lightbox-bar" }, [
        img.alt ? el("span", {}, img.alt) : null,
        el("a", { href: full, target: "_blank", rel: "noopener noreferrer" }, t("Открыть отдельно")),
        el("button", { type: "button", onclick: () => wrap.remove() }, t("Закрыть")),
      ]),
    ]);
    document.querySelector(".lightbox")?.remove();
    document.body.append(wrap);
    wrap.querySelector("button").focus();
  }

  function replacePlaceholder(area, placeholder, text) {
    const index = area.value.indexOf(placeholder);
    if (index < 0) {
      area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
    } else {
      area.setRangeText(text, index, index + placeholder.length, "end");
    }
    area.dispatchEvent(new Event("input"));
  }

  async function saveDraft(key) {
    const draft = state.drafts.get(key);
    if (!draft || draft.saving) return;
    const title = draft.title.trim();
    if (!title) return toast(t("Нужно название"));
    if (/[[\]{}|]/.test(title)) return toast(t("В названии нельзя использовать [ ] { } |"));
    if (title !== key && (state.tiddlers.has(title) || (state.drafts.has(title) && title !== key))) {
      return toast(t("Тиддлер «{title}» уже есть", { title }));
    }
    const stored = state.tiddlers.get(key);
    const body = { title, text: draft.text, tags: draft.tags, type: draft.type, etag: stored ? draft.etag : "" };
    if (stored && title !== key) body.from_title = key;
    draft.saving = true;
    try {
      const saved = await api("/tiddler", { method: "PUT", body });
      if (body.from_title) removeTiddler(key);
      setTiddler(saved);
      forgetTasks();
      state.drafts.delete(key);
      dropDraft(key, draft);
      const index = state.story.indexOf(key);
      if (index >= 0) state.story[index] = saved.title;
      saveStory();
      renderStory();
      renderSidebar();
      applySiteTitle();
      setHash(saved.title);
      if (body.from_title) offerRelink(key, saved.title);
      toast(t("Сохранено"));
    } catch (error) {
      draft.saving = false;
      toast(error.message);
    }
  }

  // After a rename, links to the old title still point there. TiddlyWiki asks
  // whether to update them; so does this.
  async function offerRelink(from, to) {
    const sources = backlinks(from).filter((title) => state.tiddlers.has(title));
    if (!sources.length) return;
    const ok = window.confirm(t("На «{from}» ссылаются тиддлеры ({count}). Заменить ссылки на «{to}»?", { from, to, count: sources.length }));
    if (!ok) return;
    await loadTexts(sources);
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp("(\\[\\[(?:[^\\]|\\n]*\\|)?)" + escaped + "(\\]\\])|(\\{\\{)" + escaped + "((?:\\|\\||!!|\\}\\}))", "g");
    let failed = 0;
    for (const title of sources) {
      const tiddler = state.tiddlers.get(title);
      const text = tiddler.text.replace(pattern, (all, a, b, c, d) => (a !== undefined ? a + to + b : c + to + d));
      const tags = tiddler.tags.map((tag) => (tag === from ? to : tag));
      if (text === tiddler.text && tags.join("\n") === tiddler.tags.join("\n")) continue;
      try {
        setTiddler(await api("/tiddler", { method: "PUT", body: { title, text, tags, type: tiddler.type, etag: tiddler.etag } }));
      } catch (error) {
        failed += 1;
      }
    }
    renderStory();
    renderSidebar();
    toast(failed ? t("Не все ссылки обновлены: {count}", { count: failed }) : t("Ссылки обновлены"));
  }

  async function deleteTiddler(key) {
    const stored = state.tiddlers.get(key);
    if (!stored) return;
    if (!window.confirm(t("Удалить «{title}»? Прошлые версии останутся в истории.", { title: key }))) return;
    try {
      await api("/tiddler?title=" + encodeURIComponent(key) + "&etag=" + encodeURIComponent(stored.etag), { method: "DELETE" });
      removeTiddler(key);
      dropDraft(key, state.drafts.get(key));
      state.drafts.delete(key);
      if (exists(key)) replaceCard(key);
      else closeTiddler(key);
      renderSidebar();
      applySiteTitle();
      toast(t("Удалено"));
    } catch (error) {
      toast(error.message);
    }
  }

  // Story --------------------------------------------------------------

  function placeInStory(title, after, edit) {
    const existing = state.story.indexOf(title);
    if (existing < 0) {
      const at = after ? state.story.indexOf(after) : -1;
      if (at >= 0) state.story.splice(at + 1, 0, title);
      else state.story.unshift(title);
      const story = document.getElementById("story");
      if (story && state.story.length === 1) story.replaceChildren();
      const node = cardNode(title);
      const anchor = at >= 0 ? document.getElementById(cardId(after)) : null;
      if (anchor) anchor.after(node);
      else if (story) story.prepend(node);
      node.classList.add("arrived");
      node.addEventListener("animationend", () => node.classList.remove("arrived"), { once: true });
    }
    renderSidebarActions();
    setHash(title);
    focusCard(title, edit ? ".title-input" : null);
  }

  function openTiddler(title, after) {
    placeInStory(title, after, false);
  }

  function focusCard(title, selector) {
    requestAnimationFrame(() => {
      const node = document.getElementById(cardId(title));
      if (!node) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      node.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      const target = selector ? node.querySelector(selector) : node;
      if (target) target.focus({ preventScroll: true });
      if (selector === ".title-input" && target) target.select();
    });
  }

  function closeTiddler(title) {
    if (state.drafts.has(title) && draftChanged(title) && !window.confirm(t("Закрыть без сохранения?"))) return;
    dropDraft(title, state.drafts.get(title));
    state.drafts.delete(title);
    state.history.delete(title);
    state.story = state.story.filter((item) => item !== title);
    const node = document.getElementById(cardId(title));
    if (node) node.remove();
    if (!state.story.length) renderStory();
    renderSidebarActions();
    if (decodeHash() === title) setHash(state.story[0] || "");
  }

  function closeAll() {
    const dirty = [...state.drafts.keys()].filter(draftChanged);
    if (dirty.length && !window.confirm(t("Есть несохранённые правки. Закрыть всё?"))) return;
    state.story = [];
    state.drafts.forEach((draft, key) => dropDraft(key, draft));
    state.drafts.clear();
    state.history.clear();
    renderStory();
    renderSidebarActions();
    setHash("");
  }

  function renderSidebarActions() {
    const button = document.querySelector(".actions button:not(.primary)");
    if (button) button.disabled = !state.story.length;
    saveStory();
  }

  // The open tiddlers are kept per account in the database and, as a quick
  // fallback, in this browser. A new tiddler that never reached the draft
  // store is left out.
  function storyKey() {
    return "wiki-story:" + state.email;
  }

  function storyTitles() {
    return state.story.filter((title) => {
      const draft = state.drafts.get(title);
      return !(draft && draft.fresh && !draft.autosaved && !exists(title));
    });
  }

  function saveStory() {
    if (!state.email) return;
    try {
      localStorage.setItem(storyKey(), JSON.stringify(storyTitles()));
    } catch (error) {
      // Storage can be blocked or full; the database copy still works.
    }
    clearTimeout(storyTimer);
    storyTimer = setTimeout(pushStory, STORY_DELAY);
  }

  function pushStory(keepalive) {
    clearTimeout(storyTimer);
    storyTimer = null;
    api("/state/story", { method: "PUT", body: { titles: storyTitles() }, keepalive }).catch(() => {});
  }

  // Autosave -----------------------------------------------------------
  // An edit goes to the draft store a moment after each change, so a reload
  // or another device opens the editor where it was left. Saving, cancelling
  // or closing the tiddler removes the draft.

  function queueDraft(key) {
    if (!state.drafts.has(key)) return;
    clearTimeout(draftTimers.get(key));
    draftTimers.set(key, setTimeout(() => pushDraft(key), DRAFT_DELAY));
    showDraftStatus(key, { state: "pending" });
  }

  async function pushDraft(key, keepalive) {
    clearTimeout(draftTimers.get(key));
    draftTimers.delete(key);
    const draft = state.drafts.get(key);
    if (!draft) return;
    const request = api("/state/draft", {
      method: "PUT",
      keepalive,
      body: {
        key,
        title: draft.title,
        text: draft.text,
        tags: draft.tags,
        type: draft.type,
        etag: draft.etag || "",
        original: draft.original || "",
        fresh: !!draft.fresh,
      },
    });
    draft.inflight = request;
    try {
      const result = await request;
      if (state.drafts.get(key) !== draft) return;
      const first = !draft.autosaved;
      draft.autosaved = true;
      showDraftStatus(key, draftTimers.has(key) ? { state: "pending" } : { state: "saved", at: result.modified });
      if (first) saveStory();
    } catch (error) {
      if (state.drafts.get(key) === draft) showDraftStatus(key, { state: "error", message: error.message });
    } finally {
      if (draft.inflight === request) draft.inflight = null;
    }
  }

  function dropDraft(key, draft) {
    clearTimeout(draftTimers.get(key));
    draftTimers.delete(key);
    draftStatus.delete(key);
    if (!draft || (!draft.autosaved && !draft.inflight)) return;
    // Wait for a save still on its way, or it would bring the draft back.
    Promise.resolve(draft.inflight).catch(() => {})
      .then(() => api("/state/draft?key=" + encodeURIComponent(key), { method: "DELETE" }))
      .catch(() => {});
  }

  function flushAutosave() {
    [...draftTimers.keys()].forEach((key) => pushDraft(key, true));
    if (storyTimer) pushStory(true);
  }

  function stopAutosave() {
    draftTimers.forEach((timer) => clearTimeout(timer));
    draftTimers.clear();
    draftStatus.clear();
    clearTimeout(storyTimer);
    storyTimer = null;
  }

  function hasUnsyncedDrafts() {
    return draftTimers.size > 0
      || [...state.drafts.values()].some((draft) => draft.inflight)
      || [...draftStatus.values()].some((status) => status.state === "error");
  }

  function draftStatusText(status) {
    if (!status) return "";
    const time = (value) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(I18n.locale, { hour: "2-digit", minute: "2-digit" });
    };
    if (status.state === "pending") return t("Черновик: есть несохранённые изменения");
    if (status.state === "saved") return t("Черновик сохранён в {time}", { time: time(status.at) });
    if (status.state === "restored") return t("Черновик от {when} восстановлен", { when: formatWhen(status.at) });
    if (status.state === "error") return t("Черновик не сохранён: {error}", { error: status.message });
    return "";
  }

  function showDraftStatus(key, status) {
    draftStatus.set(key, status);
    const card = document.getElementById(cardId(key));
    const node = card && card.querySelector(".autosave");
    if (!node) return;
    node.textContent = draftStatusText(status);
    node.classList.toggle("error", status.state === "error");
  }

  function restoreDraft(saved) {
    const stored = state.tiddlers.get(saved.key);
    const draft = {
      title: saved.title || saved.key,
      text: saved.text || "",
      tags: [...(saved.tags || [])],
      type: saved.type || DEFAULT_TYPE,
      etag: saved.etag || "",
      original: saved.original || "",
      fresh: !!saved.fresh,
      autosaved: true,
    };
    if (!draft.fresh && !stored) {
      draft.fresh = true;
      draft.etag = "";
      draft.original = "";
      draft.warning = "deleted";
    } else if (stored && stored.etag !== draft.etag) {
      draft.warning = "changed";
    }
    state.drafts.set(saved.key, draft);
    draftStatus.set(saved.key, { state: "restored", at: saved.modified });
  }

  function draftWarning(key, draft) {
    if (draft.warning === "deleted") {
      return el("p", { class: "draft-warning" }, t("Пока шла эта правка, тиддлер удалили. При сохранении он будет создан заново."));
    }
    if (draft.warning !== "changed") return null;
    const stored = state.tiddlers.get(key);
    return el("div", { class: "draft-warning" }, [
      el("p", {}, stored
        ? t("Пока шла эта правка, тиддлер изменили ({who}). Сохранить поверх не получится, пока вы не согласитесь заменить новую версию.", { who: [stored.modifier, formatWhen(stored.modified)].filter(Boolean).join(", ") })
        : t("Пока шла эта правка, тиддлер изменили. Сохранить поверх не получится, пока вы не согласитесь заменить новую версию.")),
      el("button", {
        type: "button",
        onclick: () => {
          const current = state.tiddlers.get(key);
          if (!current) return;
          draft.etag = current.etag;
          draft.fresh = false;
          draft.original = key;
          draft.warning = "";
          replaceCard(key);
          queueDraft(key);
        },
      }, t("Заменить новую версию моей правкой")),
    ]);
  }

  function savedStory() {
    try {
      const value = JSON.parse(localStorage.getItem(storyKey()));
      if (!Array.isArray(value)) return null;
      return [...new Set(value.filter((title) => typeof title === "string" && title))].slice(0, 200);
    } catch (error) {
      return null;
    }
  }

  function copyLink(title) {
    const url = location.origin + "/#" + encodeURIComponent(title);
    navigator.clipboard.writeText(url).then(() => toast(t("Ссылка скопирована")), () => toast(url));
  }

  function decodeHash() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw) return "";
    try { return decodeURIComponent(raw); } catch (error) { return raw; }
  }

  function setHash(title) {
    const next = title ? "#" + encodeURIComponent(title) : "";
    if (location.hash === next) return;
    history.replaceState(null, "", title ? next : location.pathname);
  }

  function defaultTitles() {
    const text = getTiddler("$:/DefaultTiddlers").text || "";
    const titles = [];
    const pattern = /\[\[([^\]]+)\]\]|^[ \t]*([^\s[][^\n]*?)[ \t]*$/gm;
    let m;
    while ((m = pattern.exec(text))) {
      const title = (m[1] || m[2] || "").trim();
      if (title && !titles.includes(title)) titles.push(title);
    }
    return titles;
  }

  // Settings -----------------------------------------------------------
  // Everyone can change their password here. Administrators also manage
  // users and remove attached files that nothing refers to any more.

  const USER_STATUS = {
    CONFIRMED: t("Активен"),
    FORCE_CHANGE_PASSWORD: t("Ждёт первого входа"),
    RESET_REQUIRED: t("Нужен новый пароль"),
    UNCONFIRMED: t("Не подтверждён"),
  };

  async function showSettings(section) {
    try {
      applySession(await freshSession());
    } catch (error) {
      // Offline or signed out: show what the current session allows.
    }
    const sections = [["password", t("Пароль")], ["language", t("Язык")]];
    if (state.admin) sections.push(["users", t("Пользователи")], ["files", t("Файлы")]);
    let current = sections.some(([key]) => key === section) ? section : "password";
    const body = el("div", { class: "settings-body" });
    const tabs = el("div", { class: "tabs", role: "tablist" });
    const wrap = el("div", { class: "dialog-wrap", onclick: (event) => { if (event.target === wrap) wrap.remove(); } }, [
      el("section", { class: "dialog wide", role: "dialog", "aria-modal": "true", "aria-label": t("Настройки") }, [
        el("header", { class: "dialog-head" }, [
          el("h2", {}, t("Настройки")),
          iconButton("close", t("Закрыть"), () => wrap.remove()),
        ]),
        tabs,
        body,
      ]),
    ]);
    function draw() {
      tabs.replaceChildren(...sections.map(([key, label]) => el("button", {
        type: "button",
        role: "tab",
        class: key === current ? "tab active" : "tab",
        "aria-selected": String(key === current),
        onclick: () => {
          current = key;
          draw();
        },
      }, label)));
      body.replaceChildren();
      if (current === "language") languageSection(body);
      else if (current === "users") usersSection(body);
      else if (current === "files") filesSection(body);
      else passwordSection(body, wrap);
    }
    document.querySelector(".dialog-wrap")?.remove();
    document.body.append(wrap);
    draw();
  }

  function languageSection(body) {
    body.append(el("fieldset", { class: "languages" }, [
      el("legend", {}, t("Язык интерфейса")),
      ...I18n.languages.map(([code, name]) => el("label", { class: "check" }, [
        el("input", { type: "radio", name: "lang", value: code, checked: code === I18n.lang, onchange: () => switchLanguage(code) }),
        name,
      ])),
      el("p", { class: "hint" }, I18n.chosen()
        ? t("Выбор хранится в этом браузере.")
        : t("Сейчас язык взят из настроек системы.")),
    ]));
  }

  function passwordSection(body, wrap) {
    const error = el("p", { class: "error", role: "alert" });
    const oldPassword = el("input", { type: "password", autocomplete: "current-password", required: true });
    const newPassword = el("input", { type: "password", autocomplete: "new-password", required: true, minlength: "12" });
    body.append(el("form", {
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          await changePassword(oldPassword.value, newPassword.value);
          wrap.remove();
          toast(t("Пароль изменён"));
        } catch (err) {
          error.textContent = authMessage(err);
        }
      },
    }, [
      el("label", {}, [t("Текущий пароль"), oldPassword]),
      el("label", {}, [t("Новый пароль"), newPassword]),
      el("p", { class: "hint" }, t("Не короче 8 символов, со строчной буквой и цифрой.")),
      el("div", { class: "dialog-actions" }, [el("button", { type: "submit", class: "primary" }, t("Сменить пароль"))]),
      error,
    ]));
    oldPassword.focus();
  }

  function secretNote(email, password, kind) {
    const text = {
      emailed: t("Приглашение отправлено на {email}. Если письмо не придёт, передайте временный пароль сами:", { email }),
      created: t("Пользователь {email} создан, письмо не отправлялось. Передайте ему временный пароль:", { email }),
      reset: t("Новый временный пароль для {email}:", { email }),
    }[kind];
    return el("div", { class: "secret-note", role: "status" }, [
      el("p", {}, text),
      el("code", {}, password),
      el("p", { class: "hint" }, t("Пароль показан один раз. При первом входе его нужно сменить.")),
    ]);
  }

  async function usersSection(body) {
    const note = el("div");
    const list = el("div", { class: "table-wrap" }, el("p", { class: "muted" }, t("Загружаю пользователей…")));
    const email = el("input", { type: "email", required: true, placeholder: t("почта@example.com"), "aria-label": t("Почта нового пользователя") });
    const admin = el("input", { type: "checkbox" });
    const invite = el("form", {
      class: "invite",
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          const created = await api("/admin/users", { method: "POST", body: { email: email.value, admin: admin.checked } });
          note.replaceChildren(secretNote(created.email, created.temporary_password, created.emailed === false ? "created" : "emailed"));
          email.value = "";
          admin.checked = false;
          await load();
        } catch (error) {
          toast(error.message);
        }
      },
    }, [
      email,
      el("label", { class: "check" }, [admin, t("администратор")]),
      el("button", { type: "submit", class: "primary" }, t("Пригласить")),
    ]);
    body.append(invite, note, list);

    async function change(user, changes, question) {
      if (question && !window.confirm(question)) return;
      try {
        const result = await api("/admin/users", { method: "PUT", body: Object.assign({ email: user.email }, changes) });
        if (result.temporary_password) note.replaceChildren(secretNote(user.email, result.temporary_password, "reset"));
        await load();
      } catch (error) {
        toast(error.message);
      }
    }

    async function remove(user) {
      if (!window.confirm(t("Удалить пользователя {email}? Его статьи останутся, открытые тиддлеры и черновики удалятся.", { email: user.email }))) return;
      try {
        await api("/admin/users?email=" + encodeURIComponent(user.email), { method: "DELETE" });
        toast(t("Пользователь удалён"));
        await load();
      } catch (error) {
        toast(error.message);
      }
    }

    async function load() {
      let users;
      try {
        users = (await api("/admin/users")).items;
      } catch (error) {
        list.replaceChildren(el("p", { class: "error" }, error.message));
        return;
      }
      list.replaceChildren(el("table", { class: "users" }, [
        el("thead", {}, el("tr", {}, [t("Почта"), t("Статус"), t("Админ"), ""].map((text) => el("th", {}, text)))),
        el("tbody", {}, users.map((user) => el("tr", { class: user.enabled ? "" : "disabled" }, [
          el("td", {}, [user.email, user.self ? el("span", { class: "muted" }, " " + t("(вы)")) : null]),
          el("td", {}, user.enabled ? USER_STATUS[user.status] || user.status : t("Отключён")),
          el("td", {}, el("label", { class: "admin-toggle" }, [
            el("input", {
              type: "checkbox",
              checked: user.admin,
              disabled: user.self,
              "aria-label": t("Администратор {email}", { email: user.email }),
              onchange: (event) => change(user, { admin: event.target.checked }),
            }),
            el("span", { class: "narrow-only" }, t("администратор")),
          ])),
          el("td", { class: "row-actions" }, user.self ? null : [
            el("button", { type: "button", onclick: () => change(user, { reset_password: true }, t("Выдать {email} новый временный пароль? Старый перестанет работать.", { email: user.email })) }, t("Новый пароль")),
            el("button", { type: "button", onclick: () => change(user, { enabled: !user.enabled }) }, user.enabled ? t("Отключить") : t("Включить")),
            el("button", { type: "button", class: "danger", onclick: () => remove(user) }, t("Удалить")),
          ]),
        ]))),
      ]));
    }
    await load();
    email.focus();
  }

  function filesSection(body) {
    const result = el("div");
    body.append(
      el("p", {}, t("Здесь можно удалить из S3 файлы, на которые не ссылается ни одна статья и ни один черновик. Файлы, загруженные меньше часа назад, не трогаются: их могут прямо сейчас вставлять в текст.")),
      el("p", { class: "hint" }, t("Удалённый файл ещё 30 дней хранится как старая версия в S3, потом стирается насовсем. Картинки из истории правок удалённых статей после этого тоже пропадут.")),
      el("div", { class: "dialog-actions start" }, el("button", { type: "button", class: "primary", onclick: scan }, t("Найти ненужные файлы"))),
      result,
    );

    async function scan() {
      result.replaceChildren(el("p", { class: "muted" }, t("Ищу…")));
      let found;
      try {
        found = await api("/admin/files");
      } catch (error) {
        result.replaceChildren(el("p", { class: "error" }, error.message));
        return;
      }
      if (!found.items.length) {
        result.replaceChildren(el("p", {}, t("Ненужных файлов нет.")));
        return;
      }
      const run = el("button", { type: "button", class: "danger" }, t("Удалить {files} ({size})", { files: I18n.count(found.items.length, "файл"), size: formatBytes(found.bytes) }));
      run.addEventListener("click", async () => {
        if (!window.confirm(t("Удалить {files}?", { files: I18n.count(found.items.length, "файл") }))) return;
        run.disabled = true;
        try {
          const done = await api("/admin/files/cleanup", { method: "POST", body: { keys: found.items.map((item) => item.key) } });
          result.replaceChildren(el("p", {}, t("Удалено: {count} ({size}).", { count: done.deleted.length, size: formatBytes(done.bytes) })
            + (done.skipped.length ? " " + t("Пропущено {count}: пока шла проверка, на них сослались или их уже нет.", { count: done.skipped.length }) : "")));
        } catch (error) {
          run.disabled = false;
          toast(error.message);
        }
      });
      result.replaceChildren(
        el("div", { class: "table-wrap" }, el("table", { class: "users" }, [
          el("thead", {}, el("tr", {}, [t("Файл"), t("Размер"), t("Загружен")].map((text) => el("th", {}, text)))),
          el("tbody", {}, found.items.map((item) => el("tr", {}, [
            el("td", {}, el("a", { href: item.path, target: "_blank", rel: "noopener noreferrer" }, item.path.split("/").pop())),
            el("td", {}, formatBytes(item.size)),
            el("td", {}, formatWhen(item.modified)),
          ]))),
        ])),
        el("div", { class: "dialog-actions start" }, run),
      );
    }
  }

  // Helpers ------------------------------------------------------------

  function formatWhen(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(I18n.locale, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function formatDay(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("Раньше");
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    if (date.toDateString() === today.toDateString()) return t("Сегодня");
    if (date.toDateString() === yesterday.toDateString()) return t("Вчера");
    return date.toLocaleDateString(I18n.locale, { day: "numeric", month: "long", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  }

  document.addEventListener("click", (event) => {
    const image = event.target.closest && event.target.closest(".body img.zoomable");
    if (image && !image.closest(".lightbox") && event.button === 0) {
      event.preventDefault();
      openImage(image);
      return;
    }
    const link = event.target.closest && event.target.closest("a[data-title]");
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const card = link.closest("[data-card]");
    openTiddler(link.getAttribute("data-title"), card ? card.getAttribute("data-card") : null);
  });

  document.addEventListener("change", (event) => {
    const box = event.target.closest && event.target.closest("input.task-box[data-tiddler]");
    if (!box) return;
    const card = box.closest("[data-card]");
    const where = card && card.getAttribute("data-card");
    const selector = 'input.task-box[data-tiddler="' + CSS.escape(box.dataset.tiddler) + '"][data-task="' + box.dataset.task + '"]';
    toggleTask(box.dataset.tiddler, Number(box.dataset.task), box.checked);
    const again = where && document.getElementById(cardId(where));
    const focus = again && again.querySelector(selector);
    if (focus) focus.focus();
  });

  window.addEventListener("hashchange", () => {
    const title = decodeHash();
    if (title && state.email) openTiddler(title);
  });

  window.addEventListener("beforeunload", (event) => {
    flushAutosave();
    if (hasUnsyncedDrafts()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.email && Date.now() - state.loadedAt > 5 * 60 * 1000) sync();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAutosave();
  });

  window.addEventListener("pagehide", flushAutosave);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const dialog = document.querySelector(".lightbox, .dialog-wrap");
      if (dialog) dialog.remove();
    }
  });

  async function boot() {
    if (!window.AmazonCognitoIdentity || !window.WikiText || !config.userPoolId || !config.clientId) {
      root.textContent = t("Не загрузились скрипты. Обновите страницу.");
      return;
    }
    let session;
    try {
      session = await freshSession();
    } catch (error) {
      showLogin();
      return;
    }
    applySession(session);
    root.replaceChildren(el("p", { class: "loading" }, t("Загружаю тиддлеры…")));
    let saved;
    try {
      [, saved] = await Promise.all([
        loadAll(),
        api("/state").catch((error) => ({ error })),
      ]);
    } catch (error) {
      if (!error.session) root.replaceChildren(el("p", { class: "loading" }, t("Не удалось загрузить: {error}", { error: error.message })));
      return;
    }
    if (saved.error) toast(t("Черновики и открытые тиддлеры не загрузились: {error}", { error: saved.error.message }));
    stopAutosave();
    state.drafts.clear();
    (saved.drafts || []).forEach(restoreDraft);
    if (!saved.story && !savedStory()) await loadTexts(["$:/DefaultTiddlers"]).catch(() => {});
    const linked = decodeHash();
    const story = saved.story || savedStory() || defaultTitles();
    state.story = linked ? [linked, ...story.filter((title) => title !== linked)] : story;
    state.drafts.forEach((draft, key) => {
      if (!state.story.includes(key)) state.story.push(key);
    });
    saveStory();
    try {
      await loadTexts(["$:/SiteTitle", "$:/SiteSubtitle", ...state.story]);
    } catch (error) {
      toast(t("Не удалось загрузить: {error}", { error: error.message }));
    }
    renderApp();
    if (linked) setHash(linked);
    clearInterval(syncTimer);
    syncTimer = setInterval(sync, SYNC_MS);
  }

  boot();
})();
