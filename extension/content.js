// Content script: lives inside the web page. Reads the article, paints highlights,
// and handles clicks (and Enter/Space) on highlights. Talks to background.js via
// chrome.runtime messages.
//
// Script order (see manifest.json): Readability -> roles -> reading-settings ->
// highlight -> content -> reading -> speech. This file sets up self.SCR_PAGE, the
// small toolbox that reading.js and speech.js build on. See docs/ACCESSIBILITY.md.

(function () {
  if (self.__scrLoaded) return; // guard against double injection
  self.__scrLoaded = true;

  const MIN_PARAGRAPH_CHARS = 40;
  const MAX_PARAGRAPHS = 80;
  // The elements we treat as "article blocks" (one paragraph-sized chunk each).
  const BLOCK_SELECTOR = "p, li, blockquote, h1, h2, h3, h4";
  const html = document.documentElement;

  // ---------- 0. A tiny event hub so reading.js / speech.js can react ----------
  // Events: "highlights" (after painting), "cleared" (before marks are removed),
  // "root" (the reading view is about to open or close; page nodes are swapped),
  // "roles" (which highlights are shown changed: eye buttons, density, master switch),
  // "blocks" (the article blocks were (re)marked), "jumped" (JUMP_TO moved to a highlight).
  const listeners = {};
  function on(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
  }
  function emit(name, data) {
    (listeners[name] || []).forEach((fn) => {
      try { fn(data); } catch (e) { console.warn("[SCR]", name, "listener failed", e); }
    });
  }

  // Message handlers, by type. Other scripts add theirs (READER, SPEAK, ...).
  // A handler returns the reply, or a Promise of it.
  const handlers = {};

  // ---------- 1. Extract the article with Readability ----------
  let lastParse = null; // cached Readability result: { title, content } or null
  let lastParseUrl = ""; // which page (URL without #hash) lastParse belongs to

  // The page this content script is on now. Single-page apps swap articles with
  // history.pushState and no reload; the #hash alone (a table of contents) doesn't count.
  const pageKey = () => location.href.split("#")[0];

  function parseArticle() {
    const clone = document.cloneNode(true);
    // Don't let our own UI (reading view, live region) look like part of the article.
    clone.querySelectorAll("#scr-reader, #scr-live").forEach((el) => el.remove());
    // Nor our highlights and block markers: the article is the site's own text
    // (a simplified highlight goes back to its full sentence).
    clone.querySelectorAll("mark.scr-hl").forEach((m) => {
      m.replaceWith(clone.createTextNode(m.dataset.scrOriginal ?? m.textContent));
    });
    clone.querySelectorAll("[data-scr-block]").forEach((el) => {
      el.removeAttribute("data-scr-block");
      el.style.removeProperty("--scr-dim");
    });
    if (clone.body) clone.body.normalize();
    lastParse = new Readability(clone).parse();
    lastParseUrl = pageKey();
    return lastParse;
  }

  // The cached parse, unless the page moved on to another URL since.
  function getParsedArticle() {
    forgetIfNavigated();
    return lastParse || parseArticle();
  }

  // After an in-app navigation, the cached article and its highlights belong to the
  // previous page. Drop them (highlights only once none of their marks are left).
  function forgetIfNavigated() {
    if (!lastParse || lastParseUrl === pageKey()) return;
    lastParse = null;
    if (lastHighlights.length && !document.querySelector("mark.scr-hl")) lastHighlights = [];
  }

  // Readability's article HTML as a detached document (scripts never run in it).
  function articleDoc(article) {
    return new DOMParser().parseFromString(article.content, "text/html");
  }

  // "Leaf" blocks only: a <li> holding a nested list, or a <blockquote> holding
  // <p>s, is a container; its children are counted instead.
  function isLeafBlock(el) {
    return !el.querySelector("p, li, blockquote");
  }

  function extractArticle() {
    const article = parseArticle();
    if (!article) return { title: document.title, paragraphs: [] };

    const paragraphs = [];
    articleDoc(article).querySelectorAll("p, li, blockquote").forEach((el) => {
      if (!isLeafBlock(el)) return;
      const text = SCR.normalize(el.textContent || "");
      if (text.length >= MIN_PARAGRAPH_CHARS && paragraphs.length < MAX_PARAGRAPHS) {
        paragraphs.push({ id: paragraphs.length, text });
      }
    });
    return { title: article.title, paragraphs };
  }

  // ---------- 2. Article blocks: tag the live paragraphs so we can style them ----------
  // All page styling is scoped to .scr-root / .scr-block, so we never restyle
  // menus, sidebars or footers.

  function unmarkBlocks(root) {
    // The reading view sits inside <body>; re-marking the page must leave it alone.
    const inRoot = (el) => root.closest("#scr-reader") || !el.closest("#scr-reader");
    root.querySelectorAll(".scr-block").forEach((el) => {
      if (!inRoot(el)) return;
      el.classList.remove("scr-block", "scr-active", "scr-speaking");
      delete el.dataset.scrBlock;
    });
    root.querySelectorAll(".scr-root").forEach((el) => {
      if (inRoot(el)) el.classList.remove("scr-root");
    });
    root.classList.remove("scr-root");
  }

  // Lowest element that contains every one of `els`.
  function commonAncestor(els) {
    let anc = els[0].parentElement;
    while (anc && !els.every((el) => anc.contains(el))) anc = anc.parentElement;
    return anc || document.body;
  }

  // Which live elements are article blocks?
  //  - Inside the reading view, everything came from Readability, so every leaf block counts.
  //  - On the page, a block counts when its text matches a block Readability extracted.
  function findBlocks(root) {
    const candidates = [...root.querySelectorAll(BLOCK_SELECTOR)]
      .filter((el) => isLeafBlock(el) && !el.closest("[data-scr-ignore]"));
    const withText = candidates.filter((el) => SCR.normalize(el.textContent || ""));
    if (root.closest("#scr-reader")) return withText;

    const cached = !!lastParse;
    let matches = matchParsed(withText, getParsedArticle());
    // The cached parse may describe an article that has since been replaced (a
    // single-page app, or an article that loaded late): parse again once.
    if (!matches.length && cached) matches = matchParsed(withText, parseArticle());
    return mainCluster(matches);
  }

  function matchParsed(withText, article) {
    if (!article) return [];
    const wanted = new Set();
    articleDoc(article).querySelectorAll(BLOCK_SELECTOR).forEach((el) => {
      if (isLeafBlock(el)) wanted.add(SCR.normalize(el.textContent || ""));
    });
    wanted.delete("");
    return withText.filter((el) =>
      wanted.has(SCR.normalize(el.textContent)) &&
      !el.closest("nav, footer, aside, #scr-reader") // page chrome is never "the article"
    );
  }

  // A paragraph quoted in the comments, or a sidebar built from <div>s, can match
  // too. Those strays would pull .scr-root up to the page wrapper, so keep only the
  // blocks inside the deepest element that holds nearly all (>= 85%) of them.
  function mainCluster(blocks) {
    if (blocks.length < 4) return blocks;
    const need = Math.ceil(blocks.length * 0.85);
    const counts = new Map();
    for (const b of blocks) {
      for (let a = b.parentElement; a; a = a.parentElement) counts.set(a, (counts.get(a) || 0) + 1);
    }
    let best = null;
    let bestDepth = -1;
    for (const [el, n] of counts) {
      if (n < need) continue;
      let depth = 0;
      for (let a = el; a; a = a.parentElement) depth++;
      if (depth > bestDepth) { best = el; bestDepth = depth; }
    }
    return best ? blocks.filter((b) => best.contains(b)) : blocks;
  }

  function markBlocks(root = document.body) {
    unmarkBlocks(root);
    const blocks = findBlocks(root);
    blocks.forEach((el, i) => {
      el.classList.add("scr-block");
      el.dataset.scrBlock = String(i);
    });
    if (blocks.length) commonAncestor(blocks).classList.add("scr-root");
    emit("blocks", { root }); // reading.js puts back the focus-mode active block
    return blocks.length;
  }

  // The blocks that belong to `root` (page blocks never include the reading view's).
  function blocksIn(root = getRoot()) {
    const inReader = !!root.closest("#scr-reader");
    return [...root.querySelectorAll(".scr-block")]
      .filter((el) => inReader || !el.closest("#scr-reader"));
  }

  // Mark blocks only if this root doesn't have any yet (used "lazily" by settings).
  function ensureBlocks(root = getRoot()) {
    if (!blocksIn(root).length) markBlocks(root);
    return blocksIn(root);
  }

  // ---------- 3. Where highlights live: the page, or the reading view ----------
  let currentRoot = null; // null = document.body
  let lastHighlights = []; // what the backend sent, so we can re-paint elsewhere

  function getRoot() {
    return currentRoot && currentRoot.isConnected ? currentRoot : document.body;
  }
  function setRoot(el) {
    currentRoot = el || null;
  }
  function getHighlights() {
    forgetIfNavigated();
    return lastHighlights;
  }

  // ---------- 4. Colors (saved per user, same on every page) ----------
  function applyColors(colors) {
    for (const [role, color] of Object.entries(colors)) {
      html.style.setProperty(`--scr-color-${role}`, color);
    }
  }
  scrLoadColors().then(applyColors);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.colors) scrLoadColors().then(applyColors);
  });

  // ---------- 5. Which roles are hidden ----------
  // Two independent reasons a role can be hidden: the panel's eye buttons ("user")
  // and the reading-comfort density setting ("density"). We keep them apart so
  // turning one off never undoes the other, and apply the union as html classes.
  const hiddenBy = { user: new Set(), density: new Set() };

  function setHiddenRoles(source, roles) {
    const next = new Set(roles);
    const prev = hiddenBy[source];
    // Nothing changed (e.g. a font change re-applies the same density): don't
    // restyle or tell the panel again.
    if (next.size === prev.size && [...next].every((r) => prev.has(r))) return;
    hiddenBy[source] = next;
    applyRoleClasses();
  }

  // Every role that is not shown right now (all four with the master switch off).
  function hiddenRoleList() {
    return SCR_ROLES.map((r) => r.key).filter(isRoleHidden);
  }

  function isRoleHidden(role) {
    return html.classList.contains("scr-hidden") || html.classList.contains(`scr-hide-${role}`);
  }

  function applyRoleClasses() {
    for (const { key } of SCR_ROLES) {
      const hide = hiddenBy.user.has(key) || hiddenBy.density.has(key);
      html.classList.toggle(`scr-hide-${key}`, hide);
    }
    refreshMarkButtons();
    emit("roles");
  }

  // ---------- 5b. Dark sites ----------
  // The highlight wash and underline need different values on a dark background
  // (content.css). The extension's own dark theme sets them itself; a site that is
  // dark on its own (theme "site") gets html.scr-dark-site, measured here.
  function parseRgb(str) {
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/.exec(str || "");
    if (!m) return null;
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith("%")) a /= 100;
    return [+m[1], +m[2], +m[3], a];
  }
  function luminance(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  const blend = (top, bottom, a) => [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a));

  // The color actually behind `el`: its own or its nearest ancestor's background
  // (semi-transparent layers composited), white when nothing sets one. Pass a Map
  // as `memo` to reuse the answers for shared ancestors.
  function backgroundOf(el, memo) {
    if (!el || el.nodeType !== 1) return [255, 255, 255];
    if (memo && memo.has(el)) return memo.get(el);
    const c = parseRgb(getComputedStyle(el).backgroundColor);
    let bg;
    if (c && c[3] >= 1) bg = c.slice(0, 3);
    else {
      const under = backgroundOf(el.parentElement, memo);
      bg = c && c[3] > 0 ? blend(c, under, c[3]) : under;
    }
    if (memo) memo.set(el, bg);
    return bg;
  }

  const DARK_LUMINANCE = 0.18;
  function checkDarkSite() {
    // What the page's highlights sit on: a page block (themes paint those), else
    // the parent of the first page mark. The reading view sets its own values.
    const notReader = (el) => !el.closest("#scr-reader");
    const block = [...document.querySelectorAll(".scr-block")].find(notReader);
    const mark = [...document.querySelectorAll("mark.scr-hl")].find(notReader);
    const el = block || (mark && mark.parentElement);
    const dark = !!el && luminance(backgroundOf(el)) < DARK_LUMINANCE;
    html.classList.toggle("scr-dark-site", dark);
    return dark;
  }

  // ---------- 6. Paint highlights from the backend ----------
  function marksFor(id) {
    return [...document.querySelectorAll(`mark.scr-hl[data-scr-id="${id}"]`)];
  }

  // The first <mark> of each highlight, in document order.
  function firstMarks(root = getRoot()) {
    const seen = new Set();
    return [...root.querySelectorAll("mark.scr-hl")].filter((m) => {
      if (seen.has(m.dataset.scrId)) return false;
      seen.add(m.dataset.scrId);
      return true;
    });
  }

  function sentenceOf(id) {
    return marksFor(id).map((m) => m.dataset.scrOriginal ?? m.textContent).join("");
  }

  function roleLabel(role) {
    const r = SCR_ROLES.find((x) => x.key === role);
    return r ? r.label : "Highlight";
  }

  // Keyboard + screen readers: the first mark of each highlight acts as a button.
  // When its role is hidden it goes back to being plain text (not tabbable).
  function decorateMark(mark) {
    if (isRoleHidden(mark.dataset.scrRole)) {
      ["tabindex", "role", "aria-pressed", "aria-label"].forEach((a) => mark.removeAttribute(a));
      return;
    }
    const sentence = SCR.normalize(sentenceOf(mark.dataset.scrId));
    // Most sentences already end in . ! or ?; only add a full stop when missing.
    const stop = /[.!?…]["'”’)\]]*$/.test(sentence) ? "" : ".";
    mark.tabIndex = 0;
    mark.setAttribute("role", "button");
    mark.setAttribute("aria-pressed", String(mark.dataset.scrOriginal !== undefined));
    mark.setAttribute("aria-label",
      `${roleLabel(mark.dataset.scrRole)}: ${sentence}${stop} Press Enter for the sentence backbone.`);
  }

  function refreshMarkButtons() {
    document.querySelectorAll("mark.scr-hl").forEach((m) => {
      if (m.hasAttribute("role")) ["tabindex", "role", "aria-pressed", "aria-label"].forEach((a) => m.removeAttribute(a));
    });
    firstMarks(document).forEach(decorateMark);
  }

  function applyHighlights(highlights, root = getRoot()) {
    clearAll();
    lastHighlights = highlights;
    const ids = SCR.highlightAll(highlights.map((h) => ({ text: h.text, role: h.role })), root);
    refreshMarkButtons();
    checkDarkSite();
    const found = ids.filter(Boolean).length;
    emit("highlights", { found, total: highlights.length });
    sendHighlightsState();
    return { found, total: highlights.length };
  }

  function clearAll() {
    emit("cleared");
    document.querySelectorAll("mark.scr-hl[data-scr-original]").forEach(unsimplify);
    // Marks can be on the page or inside the reading view; clear both.
    SCR.clearHighlights(document.body);
  }

  // ---------- 7. Screen-reader announcements ----------
  // One visually hidden polite live region. While the reading view (a modal
  // dialog) is open, it lives inside it, because screen readers ignore content
  // outside an aria-modal dialog.
  function liveRegion() {
    let live = document.getElementById("scr-live");
    if (!live) {
      live = document.createElement("div");
      live.id = "scr-live";
      live.setAttribute("aria-live", "polite");
      live.setAttribute("data-scr-ignore", "");
    }
    const home = document.getElementById("scr-reader") || document.body;
    if (live.parentNode !== home) home.appendChild(live);
    return live;
  }

  let announceTimer = 0;
  function announce(text) {
    const live = liveRegion();
    // Empty it first, then set the text a moment later, so repeating the same
    // message is still read out.
    live.textContent = "";
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { live.textContent = text; }, 50);
  }

  // ---------- 7b. Key points list (the panel's outline of the highlights) ----------
  // The panel lists every painted highlight in document order and can ask us to
  // jump to one (JUMP_TO). See docs/ACCESSIBILITY.md, "Key points list".

  // What the panel needs to draw the list: id, role and the full sentence of every
  // highlight in the current root (the page, or the reading view while it's open).
  function highlightsState() {
    const items = firstMarks().map((m) => ({
      id: m.dataset.scrId,
      role: m.dataset.scrRole,
      text: SCR.normalize(sentenceOf(m.dataset.scrId)),
    }));
    return { items, hiddenRoles: hiddenRoleList() };
  }

  function sendHighlightsState() {
    notifyPanel({ type: "HIGHLIGHTS_STATE", ...highlightsState() });
  }

  // Show a hidden role again, so a jump never lands on an invisible sentence.
  //  - master switch off -> switch it back on (as if the reader flipped it);
  //  - hidden with its eye button -> as if the eye button were pressed back on;
  //  - hidden by "Highlights to show" (density) -> pick the smallest density that
  //    includes this role and save it, so the panel and other tabs agree.
  // Returns what it changed, so the panel can tell the reader (a saved setting
  // must never change silently): {master, eye, density: {from, to, presetWas}|null}.
  // `saved` resolves once the density change is stored.
  function unhideRole(role) {
    const revealed = {
      role,
      master: html.classList.contains("scr-hidden"),
      eye: hiddenBy.user.has(role),
      density: null,
    };
    let saved = Promise.resolve();
    html.classList.remove("scr-hidden");
    hiddenBy.user.delete(role);
    if (hiddenBy.density.has(role)) {
      const level = Object.keys(SCR_DENSITY)
        .filter((k) => SCR_DENSITY[k].roles.includes(role))
        .sort((a, b) => SCR_DENSITY[a].roles.length - SCR_DENSITY[b].roles.length)[0] || "all";
      hiddenBy.density = new Set(SCR_ROLES.map((r) => r.key).filter((k) => !SCR_DENSITY[level].roles.includes(k)));
      revealed.density = { from: null, to: level, presetWas: null };
      saved = scrLoadReading()
        .then((before) => {
          revealed.density.from = before.density;
          revealed.density.presetWas = before.preset;
          return scrSaveReading({ density: level, preset: "custom" });
        })
        .catch(() => {});
    }
    applyRoleClasses(); // re-decorates the marks and emits "roles" (-> HIGHLIGHTS_STATE)
    return { revealed, saved };
  }

  // The marks of a highlight in the current root. Ids change every time the page
  // re-paints (reading view open/close), so a JUMP_TO sent just before a re-paint
  // can carry an old id: then find the same highlight by role + sentence (+ which
  // repeat of that sentence, `n`, 1-based), the way the panel keys its rows.
  function findJumpMarks(msg) {
    const root = getRoot();
    const id = String(msg.id);
    let marks = marksFor(id).filter((m) => root.contains(m));
    if (marks.length || !msg.role || !msg.text) return marks;
    const same = firstMarks(root).filter((m) =>
      m.dataset.scrRole === msg.role && SCR.normalize(sentenceOf(m.dataset.scrId)) === msg.text);
    const hit = same[(Number(msg.n) || 1) - 1];
    return hit ? marksFor(hit.dataset.scrId).filter((m) => root.contains(m)) : [];
  }

  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let flashTimer = 0;

  function jumpTo(msg) {
    const marks = findJumpMarks(msg);
    if (!marks.length) return { ok: false, error: "That highlight is no longer on the page." };
    const first = marks[0];
    const id = first.dataset.scrId;
    const role = first.dataset.scrRole;
    const reveal = isRoleHidden(role) ? unhideRole(role) : null;

    // 1. Scroll it to the middle of the screen (inside the reading view when open:
    //    scrollIntoView scrolls whichever box actually scrolls).
    first.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" });

    // 2. Outline the whole sentence for a moment (content.css: .scr-flash).
    clearTimeout(flashTimer);
    document.querySelectorAll("mark.scr-flash").forEach((m) => m.classList.remove("scr-flash"));
    marks.forEach((m) => m.classList.add("scr-flash"));
    flashTimer = setTimeout(() => marks.forEach((m) => m.classList.remove("scr-flash")), 1500);

    // 3. Keyboard focus on the sentence, so Enter shows its backbone right away.
    first.focus({ preventScroll: true });

    // 4. Focus mode follows the jump.
    const block = first.closest(".scr-block");
    if (block && self.SCR_PAGE.isFocusMode && self.SCR_PAGE.isFocusMode()) self.SCR_PAGE.setActiveBlock(block);

    announce(`Jumped to ${roleLabel(role)}.`);
    emit("jumped", { id });
    if (!reveal) return { ok: true, id };
    return reveal.saved.then(() => ({ ok: true, id, revealed: reveal.revealed }));
  }

  // The shown highlights changed (eye buttons, density, master switch): the
  // panel greys out the hidden ones. Only on a highlighted page.
  on("roles", () => { if (firstMarks().length) sendHighlightsState(); });

  // ---------- 8. Click / Enter on a highlight -> bold the backbone, fade the rest ----------
  function unsimplify(mark) {
    mark.textContent = mark.dataset.scrOriginal;
    delete mark.dataset.scrOriginal;
  }

  function renderCore(marks, core) {
    // One sentence may be split over several <mark>s; work on the joined text.
    const full = marks.map((m) => m.textContent).join("");
    const isCore = new Array(full.length).fill(false);
    let from = 0;
    for (const piece of core) {
      const at = full.indexOf(piece, from);
      if (at < 0) continue;
      isCore.fill(true, at, at + piece.length);
      from = at + piece.length;
    }
    let pos = 0;
    for (const mark of marks) {
      const text = mark.textContent;
      mark.dataset.scrOriginal = text;
      mark.textContent = "";
      let i = 0;
      while (i < text.length) {
        const flag = isCore[pos + i];
        let j = i;
        while (j < text.length && isCore[pos + j] === flag) j++;
        const span = document.createElement("span");
        span.className = flag ? "scr-core" : "scr-faded";
        span.textContent = text.slice(i, j);
        mark.appendChild(span);
        i = j;
      }
      pos += text.length;
    }
  }

  function setPressed(marks, pressed) {
    if (marks[0] && marks[0].hasAttribute("role")) marks[0].setAttribute("aria-pressed", String(pressed));
  }

  async function toggleBackbone(mark) {
    if (isRoleHidden(mark.dataset.scrRole)) return;
    const marks = marksFor(mark.dataset.scrId);

    if (mark.dataset.scrOriginal !== undefined) { // already simplified -> toggle back
      marks.forEach(unsimplify);
      setPressed(marks, false);
      announce("Showing the full sentence.");
      return;
    }
    if (mark.classList.contains("scr-loading")) return; // a request is already running
    const sentence = marks.map((m) => m.textContent).join("");
    marks.forEach((m) => m.classList.add("scr-loading"));
    announce("Simplifying…");
    try {
      const res = await chrome.runtime.sendMessage({ type: "SIMPLIFY", sentence });
      if (res && res.ok) {
        renderCore(marks, res.data.core);
        setPressed(marks, true);
        announce(`Backbone: ${res.data.core.join(" ")}`);
      } else {
        console.warn("[SCR] simplify failed", res && res.error);
        announce("Couldn't simplify this sentence.");
      }
    } catch (e) {
      console.warn("[SCR] simplify failed", e);
      announce("Couldn't simplify this sentence.");
    } finally {
      marks.forEach((m) => m.classList.remove("scr-loading"));
    }
  }

  document.addEventListener("click", (e) => {
    const mark = e.target.closest && e.target.closest("mark.scr-hl");
    if (mark) toggleBackbone(mark);
  });

  // Enter / Space on a focused highlight does the same as a click.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const mark = e.target.closest && e.target.closest('mark.scr-hl[role="button"]');
    if (!mark || e.target !== mark) return;
    e.preventDefault(); // Space would scroll the page, Enter might follow a parent link
    toggleBackbone(mark);
  });

  // ---------- 9. Messages from background / side panel ----------
  handlers.PING = (msg) => {
    console.log("[SCR] ping from", msg.from);
    return { ok: true, url: location.href };
  };
  handlers.EXTRACT = () => {
    const article = extractArticle();
    markBlocks(); // the page's blocks, for reading settings, focus mode and progress
    checkDarkSite();
    console.log("[SCR] extracted", article.paragraphs.length, "paragraphs", article);
    return { ok: true, data: article };
  };
  handlers.APPLY_HIGHLIGHTS = (msg) => ({ ok: true, data: applyHighlights(msg.highlights) });
  handlers.SET_VISIBLE = (msg) => {
    html.classList.toggle("scr-hidden", !msg.visible);
    refreshMarkButtons();
    emit("roles");
    return { ok: true };
  };
  handlers.SET_ROLE_VISIBLE = (msg) => {
    hiddenBy.user[msg.visible ? "delete" : "add"](msg.role);
    applyRoleClasses();
    return { ok: true };
  };
  handlers.CLEAR = () => {
    clearAll();
    lastHighlights = [];
    sendHighlightsState(); // an empty list
    return { ok: true };
  };
  handlers.JUMP_TO = (msg) => jumpTo(msg || {});
  // How many highlights per role the backend sent (null = this page isn't highlighted).
  function roleCounts() {
    if (!lastHighlights.length) return null;
    const counts = {};
    for (const { key } of SCR_ROLES) counts[key] = 0;
    lastHighlights.forEach((h) => { counts[h.role] = (counts[h.role] || 0) + 1; });
    return counts;
  }

  handlers.GET_PAGE_STATE = () => ({
    ok: true,
    reader: SCR_PAGE.isReaderOpen ? SCR_PAGE.isReaderOpen() : false,
    speech: SCR_PAGE.getSpeechState
      ? SCR_PAGE.getSpeechState()
      : { state: "stopped", index: 0, total: 0, text: "" },
    progress: SCR_PAGE.getProgress ? SCR_PAGE.getProgress() : null,
    // So the panel can rebuild its legend after a tab switch:
    counts: (forgetIfNavigated(), roleCounts()),
    found: firstMarks().length,
    hiddenRoles: [...hiddenBy.user],
    visible: !html.classList.contains("scr-hidden"),
    highlights: highlightsState(), // for the key points list
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = handlers[msg && msg.type];
    if (!handler) return false;
    let reply;
    try {
      reply = handler(msg);
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
      return false;
    }
    if (reply && typeof reply.then === "function") {
      reply.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true; // keep the channel open for the async reply
    }
    sendResponse(reply);
    return false;
  });

  // Messages to the side panel. It may be closed, so never let that throw.
  function notifyPanel(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      // The extension was reloaded; this old content script can't talk any more.
    }
  }

  // ---------- 10. The toolbox for reading.js and speech.js ----------
  // reading.js adds: isReaderOpen, getProgress, setActiveBlock, isFocusMode
  // speech.js adds:  getSpeechState
  self.SCR_PAGE = {
    extractArticle, applyHighlights, getHighlights, getRoot, markBlocks, announce,
    // extras used by the other page scripts:
    setRoot, ensureBlocks, blocksIn, getParsedArticle, firstMarks, marksFor, isRoleHidden,
    setHiddenRoles, on, emit, handlers, notifyPanel,
    parseArticle, parseRgb, luminance, blend, backgroundOf, checkDarkSite,
    sendHighlightsState,
  };
})();
