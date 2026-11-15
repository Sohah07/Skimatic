// Reading comfort, page side: text settings, themes, fonts, the clean reading
// view, focus mode, highlight density and reading progress.
// Builds on self.SCR_PAGE from content.js. Spec: docs/ACCESSIBILITY.md ("Page side").

(function () {
  if (self.__scrReadingLoaded) return; // guard against double injection
  self.__scrReadingLoaded = true;

  const P = self.SCR_PAGE;
  const html = document.documentElement;
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollBehavior = () => (reducedMotion() ? "instant" : "smooth");

  let settings = { ...SCR_READING_DEFAULTS };

  // ======================================================================
  // 1. Fonts: bundled with the extension (SIL Open Font License), loaded
  //    only once a reader actually picks one of them.
  // ======================================================================
  const BUNDLED_FONTS = { atkinson: ["SCR Atkinson", "atkinson-hyperlegible"], lexend: ["SCR Lexend", "lexend"] };

  function injectFonts() {
    if (document.getElementById("scr-fonts")) return;
    const rules = [];
    for (const [family, file] of Object.values(BUNDLED_FONTS)) {
      for (const weight of [400, 700]) {
        const url = chrome.runtime.getURL(`fonts/${file}-${weight}.woff2`);
        rules.push(`@font-face { font-family: "${family}"; font-style: normal; ` +
          `font-weight: ${weight}; font-display: swap; src: url("${url}") format("woff2"); }`);
      }
    }
    const style = document.createElement("style");
    style.id = "scr-fonts";
    style.textContent = rules.join("\n");
    (document.head || html).appendChild(style);
  }

  // ======================================================================
  // 2. Text settings + theme, as CSS variables and classes on <html>.
  //    reading.css turns them into styles, scoped to .scr-root / .scr-block.
  // ======================================================================
  const THEME_NAMES = Object.keys(SCR_THEMES);

  function setTextVars(s) {
    const font = SCR_FONTS[s.font] || SCR_FONTS.site;
    html.style.setProperty("--scr-font", font.stack || "inherit");
    html.style.setProperty("--scr-size", `${s.size}px`);
    html.style.setProperty("--scr-ls", `${s.letterSpacing}em`);
    html.style.setProperty("--scr-ws", `${s.wordSpacing}em`);
    html.style.setProperty("--scr-lh", String(s.lineHeight));
    html.style.setProperty("--scr-lw", `${s.lineWidth}ch`);
  }

  // Copy one theme's colors into CSS variables on `el`.
  function setThemeVars(el, themeName) {
    const t = SCR_THEMES[themeName];
    for (const key of ["bg", "fg", "fade", "link"]) {
      if (t && t[key]) el.style.setProperty(`--scr-${key}`, t[key]);
      else el.style.removeProperty(`--scr-${key}`);
    }
  }

  function applyTheme(s) {
    // The page theme only applies while text settings are on. "site" changes nothing.
    const theme = s.enabled && s.theme !== "site" && SCR_THEMES[s.theme] ? s.theme : "site";
    THEME_NAMES.forEach((name) => html.classList.toggle(`scr-theme-${name}`, name === theme && name !== "site"));
    setThemeVars(html, theme);
  }

  function applyDensity(s) {
    const shown = (SCR_DENSITY[s.density] || SCR_DENSITY.all).roles;
    const hidden = SCR_ROLES.map((r) => r.key).filter((k) => !shown.includes(k));
    P.setHiddenRoles("density", hidden);
  }

  // The settings that change what the page's text looks like (and so the focus-mode
  // dimming). Speech settings, for example, don't touch the page at all.
  const PAGE_KEYS = ["enabled", "font", "size", "letterSpacing", "wordSpacing", "lineHeight",
    "lineWidth", "theme", "focusMode", "density"];
  // Only these change the colors focus mode measures (or switch it on/off).
  const DIM_KEYS = ["enabled", "font", "theme", "focusMode"];
  let applied = null; // the settings last applied to the page

  function applySettings(s) {
    const prev = applied;
    const changed = (keys) => !prev || keys.some((k) => prev[k] !== s[k]);
    settings = s;
    applied = s;
    if (!changed(PAGE_KEYS)) return; // e.g. speech rate / voice: nothing to restyle
    if (BUNDLED_FONTS[s.font]) injectFonts();
    // Styling needs to know which elements are the article, so find them now.
    const before = P.blocksIn(document.body)[0];
    if (s.enabled || s.focusMode) P.ensureBlocks(document.body);
    const blocksChanged = P.blocksIn(document.body)[0] !== before;
    setTextVars(s);
    html.classList.toggle("scr-read", !!s.enabled);
    html.classList.toggle("scr-font", !!(SCR_FONTS[s.font] && SCR_FONTS[s.font].stack));
    applyTheme(s);
    P.checkDarkSite(); // the theme may have painted the blocks
    if (changed(["density"])) applyDensity(s);
    if (reader) styleReader(reader.overlay); // before focus mode, which reads the colors
    if (changed(DIM_KEYS) || blocksChanged || !dimmed.every((b) => b.isConnected)) setFocusMode(!!s.focusMode);
    scheduleProgress();
  }

  scrLoadReading().then(applySettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.reading) scrLoadReading().then(applySettings);
  });

  // ======================================================================
  // 3. Focus mode: dim every block except the active one.
  // ======================================================================
  let activeBlock = null;
  let pointerTimer = 0;

  // Always (re)adds the class: re-marking the blocks (a new analysis) strips it
  // from the same element we still hold.
  function setActiveBlock(el) {
    if (activeBlock && activeBlock !== el) activeBlock.classList.remove("scr-active");
    activeBlock = el || null;
    if (activeBlock) activeBlock.classList.add("scr-active");
  }

  function isFocusMode() {
    return html.classList.contains("scr-focus");
  }

  // The block nearest the upper-middle of the screen, where the eye usually is.
  function blockInView(blocks) {
    const target = innerHeight * 0.4;
    let best = null;
    let bestDist = Infinity;
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      const dist = r.top <= target && r.bottom >= target ? 0 : Math.min(Math.abs(r.top - target), Math.abs(r.bottom - target));
      if (dist < bestDist) { best = b; bestDist = dist; }
    }
    return best;
  }

  // ---- How much to dim, without breaking contrast ----
  // The other blocks' text is drawn at --scr-dim of its own color (reading.css).
  // Work out the lowest share that still keeps >= 4.5:1 (4.6 for rounding) on
  // the article's own background, and never go below 65%.
  const MIN_DIM = 0.65;
  const TARGET_RATIO = 4.6;

  // Color helpers live in content.js (also used for dark-site detection).
  const { parseRgb, luminance, blend, backgroundOf } = P;
  const contrast = (a, b) => {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  // The lowest share for one text color on one background.
  function shareFor(fg, bg) {
    const text = blend(fg, bg, fg[3]);
    if (contrast(text, bg) < TARGET_RATIO) return 1; // already low: don't dim at all
    let a = 1;
    while (a - 0.01 >= MIN_DIM && contrast(blend(text, bg, a - 0.01), bg) >= TARGET_RATIO) a -= 0.01;
    return Math.round(a * 100) / 100;
  }

  // One share per block, safe for every text color inside it: a grey blockquote, an
  // editor's note on a tinted box or a grey <span> needs less dimming than the body
  // text. Highlights and links aren't dimmed, so they don't count.
  function blockDimShare(block, cache, bgMemo) {
    let share = MIN_DIM;
    const els = [block, ...block.querySelectorAll("*")];
    for (const el of els) {
      if (el !== block && el.closest("mark.scr-hl, a")) continue;
      if (el !== block && ![...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim())) continue;
      const color = getComputedStyle(el).color;
      const bg = backgroundOf(el, bgMemo);
      const key = color + "|" + bg.join(",");
      let s = cache.get(key);
      if (s === undefined) {
        const fg = parseRgb(color);
        s = fg ? shareFor(fg, bg) : 1;
        cache.set(key, s);
      }
      if (s > share) share = s;
      if (share >= 1) break;
    }
    return share;
  }

  let dimmed = []; // blocks that carry their own --scr-dim
  function clearDim() {
    dimmed.forEach((b) => b.style.removeProperty("--scr-dim"));
    dimmed = [];
  }

  function setFocusMode(onOff) {
    html.classList.toggle("scr-focus", onOff);
    clearDim();
    if (!onOff) {
      clearTimeout(pointerTimer); // a pending pointer move must not re-activate a block
      return setActiveBlock(null);
    }
    const blocks = P.blocksIn(P.getRoot());
    const cache = new Map();
    const bgMemo = new Map(); // backgrounds of shared ancestors are worked out once
    for (const b of blocks) {
      b.style.setProperty("--scr-dim", `${Math.round(blockDimShare(b, cache, bgMemo) * 100)}%`);
      dimmed.push(b);
    }
    // Keep the active block (re-adding its class, which re-marking removes), or pick one.
    setActiveBlock(blocks.includes(activeBlock) ? activeBlock : blockInView(blocks));
  }

  // The blocks were re-marked (a new analysis runs EXTRACT first), which strips
  // .scr-active. Same blocks as before: just put the class back. Different
  // blocks: work the dimming out again.
  P.on("blocks", ({ root }) => {
    if (!isFocusMode() || root !== P.getRoot()) return;
    const blocks = P.blocksIn(root);
    const same = blocks.length === dimmed.length && blocks.every((b) => dimmed.includes(b));
    if (same) setActiveBlock(blocks.includes(activeBlock) ? activeBlock : blockInView(blocks));
    else setFocusMode(true);
  });

  // Follow the pointer, but wait ~120ms so sweeping across the page doesn't flicker.
  document.addEventListener("pointerover", (e) => {
    if (!isFocusMode()) return;
    const block = e.target.closest && e.target.closest(".scr-block");
    clearTimeout(pointerTimer);
    if (!block || !P.blocksIn(P.getRoot()).includes(block)) return;
    pointerTimer = setTimeout(() => { if (isFocusMode()) setActiveBlock(block); }, 120);
  }, { passive: true });

  function isTyping(el) {
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  // j = next block, k = previous block (only in focus mode, and never while typing).
  function moveActive(step) {
    const blocks = P.blocksIn(P.getRoot());
    if (!blocks.length) return;
    const at = blocks.indexOf(activeBlock);
    const next = at < 0 ? blocks[0] : blocks[Math.min(blocks.length - 1, Math.max(0, at + step))];
    setActiveBlock(next);
    next.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }

  document.addEventListener("keydown", (e) => {
    if (!isFocusMode() || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
    if (e.key !== "j" && e.key !== "k") return;
    e.preventDefault();
    moveActive(e.key === "j" ? 1 : -1);
  });

  // ======================================================================
  // 4. Clean reading view: a full-screen dialog built from Readability's article.
  // ======================================================================
  let reader = null; // { overlay, body, returnFocus, inerted: [] } while open

  // Strip anything that could run code or submit data. Readability already cleans
  // a lot; this is a second, explicit pass because we insert the HTML into the page.
  // SVG animation elements can rewrite an attribute (e.g. a link's href) to a script URL.
  const UNSAFE = "script, style, iframe, frame, frameset, form, object, embed, link, meta, base, noscript, " +
    "animate, set, animateMotion, animateTransform, discard";
  // Browsers ignore ASCII whitespace and control characters inside a URL scheme
  // ("java\tscript:"), so strip them before checking.
  const isScriptUrl = (v) => /^(javascript|vbscript):/i.test(String(v).replace(/[\u0000-\u0020\u007f]+/g, ""));
  function cleanArticleNodes(articleHtml) {
    const doc = new DOMParser().parseFromString(articleHtml, "text/html");
    doc.querySelectorAll(UNSAFE).forEach((el) => el.remove());
    doc.body.querySelectorAll("*").forEach((el) => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const jsUrl = isScriptUrl(attr.value); // whatever the attribute's name
        // ids are dropped too, so they can't clash with the page behind the dialog.
        if (name.startsWith("on") || jsUrl || name === "id") el.removeAttribute(attr.name);
      }
    });
    return [...doc.body.childNodes].map((n) => document.adoptNode(n));
  }

  function buildReader(article) {
    const overlay = document.createElement("div");
    overlay.id = "scr-reader";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "scr-reader-title");

    const bar = document.createElement("div");
    bar.className = "scr-reader-bar";
    bar.setAttribute("data-scr-ignore", "");
    const title = document.createElement("h1");
    title.id = "scr-reader-title";
    title.className = "scr-reader-title";
    title.textContent = article.title || document.title || "Article";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "scr-reader-close";
    close.textContent = "Close (Esc)";
    close.addEventListener("click", () => closeReader());
    bar.append(title, close);

    const body = document.createElement("div");
    body.className = "scr-reader-body";
    body.append(...cleanArticleNodes(article.content));

    overlay.append(bar, body);
    return { overlay, bar, body, close };
  }

  // Keep focused content clear of the sticky header (WCAG 2.4.11): the overlay's
  // scroll-padding-top follows the bar's real height. When the bar would take more
  // than a quarter of the screen (narrow window, large text), it scrolls away with
  // the article instead of covering it.
  function fitBar(overlay, bar) {
    overlay.style.setProperty("--scr-bar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    overlay.classList.toggle("scr-bar-static", bar.offsetHeight > innerHeight * 0.25);
  }
  function watchBar(overlay, bar) {
    const fit = () => fitBar(overlay, bar);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    addEventListener("resize", fit);
    return () => { ro.disconnect(); removeEventListener("resize", fit); };
  }

  // The reading view always uses the text settings, and cream when the theme is "site".
  function styleReader(overlay) {
    const theme = settings.theme === "site" || !SCR_THEMES[settings.theme] ? "cream" : settings.theme;
    setThemeVars(overlay, theme);
    overlay.dataset.scrTheme = theme; // reading.css / content.css: dark-theme highlight colors
    // With font = "site", keep the site's own body font instead of the browser default.
    const sample = document.querySelector(".scr-block:not(#scr-reader *)") || document.body;
    overlay.style.setProperty("--scr-site-font", getComputedStyle(sample).fontFamily);
  }

  // Make everything behind the dialog unreachable (Tab, clicks, screen readers).
  function inertSiblings(overlay) {
    const inerted = [];
    for (const el of document.body.children) {
      if (el !== overlay && !el.inert) {
        el.inert = true;
        inerted.push(el);
      }
    }
    return inerted;
  }

  // Remember what had focus before the dialog opened. Highlights are re-painted
  // while the dialog is open (new <mark> elements), so for a highlight we also
  // remember its sentence and find the new mark for it on close.
  function focusMemo(el) {
    const mark = el && el.closest && el.closest("mark.scr-hl");
    if (!mark) return { el };
    return { el, sentence: SCR.normalize(P.marksFor(mark.dataset.scrId).map((m) => m.textContent).join("")) };
  }

  function restoreFocus({ el, sentence }) {
    let target = el && el.isConnected ? el : null;
    if (!target && sentence) {
      target = P.firstMarks(document.body).find((m) =>
        SCR.normalize(P.marksFor(m.dataset.scrId).map((x) => x.textContent).join("")) === sentence);
    }
    if (target && target.focus) target.focus({ preventScroll: true });
  }

  function isReaderOpen() {
    return !!reader;
  }

  function readerChanged() {
    P.notifyPanel({ type: "READER_STATE", open: isReaderOpen() });
    sendProgressNow();
  }

  function openReader() {
    if (reader) return { ok: true, open: true };
    // Parse afresh: the page may have swapped its article since (single-page apps).
    const article = P.parseArticle();
    if (!article) return { ok: false, open: false, error: "Couldn't find an article on this page." };

    const returnFocus = focusMemo(document.activeElement);
    const { overlay, bar, body, close } = buildReader(article);
    styleReader(overlay);
    document.body.appendChild(overlay);
    const unwatchBar = watchBar(overlay, bar);
    const live = document.getElementById("scr-live");
    if (live) overlay.appendChild(live); // announcements must come from inside the dialog
    html.classList.add("scr-reader-open");
    reader = { overlay, body, returnFocus, unwatchBar, inerted: inertSiblings(overlay) };

    P.emit("root"); // anything tied to page elements (speech) lets go of them
    P.markBlocks(body);
    P.setRoot(body);
    if (P.getHighlights().length) P.applyHighlights(P.getHighlights(), body);
    if (isFocusMode()) setFocusMode(true);
    close.focus();
    readerChanged();
    return { ok: true, open: true };
  }

  function closeReader() {
    if (!reader) return { ok: true, open: false };
    const { overlay, returnFocus, inerted, unwatchBar } = reader;
    unwatchBar();
    P.emit("root");
    inerted.forEach((el) => { el.inert = false; });
    const live = document.getElementById("scr-live");
    if (live) document.body.appendChild(live);
    overlay.remove();
    reader = null;
    html.classList.remove("scr-reader-open");

    P.setRoot(null);
    if (P.getHighlights().length) P.applyHighlights(P.getHighlights(), document.body);
    if (isFocusMode()) setFocusMode(true);
    restoreFocus(returnFocus);
    readerChanged();
    return { ok: true, open: false };
  }

  document.addEventListener("keydown", (e) => {
    if (reader && e.key === "Escape") {
      e.preventDefault();
      closeReader();
    }
  }, true);

  P.handlers.READER = (msg) => {
    const want = msg.action === "toggle" ? !reader : msg.action === "open";
    return want ? openReader() : closeReader();
  };

  // ======================================================================
  // 5. Progress: key points seen, minutes left, percent read.
  // ======================================================================
  const WORDS_PER_MINUTE = 230;
  const seen = new Set(); // sentence texts that have been >= 50% on screen
  let seenFor = null;     // which highlight list `seen` belongs to
  let observer = null;

  const keyOf = (mark) => SCR.normalize(P.marksFor(mark.dataset.scrId).map((m) => m.textContent).join(""));

  function observeMarks() {
    if (observer) observer.disconnect();
    // A new analysis starts the count over; re-painting the same one (reading
    // view open/close) keeps what was already seen.
    if (seenFor !== P.getHighlights()) { seen.clear(); seenFor = P.getHighlights(); }
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.intersectionRatio >= 0.5) {
          seen.add(keyOf(entry.target));
          observer.unobserve(entry.target);
        }
      }
      scheduleProgress();
    }, { threshold: 0.5 });
    P.firstMarks().forEach((m) => observer.observe(m));
  }

  const countWords = (el) => (el.textContent.match(/\S+/g) || []).length;

  // The key point the reader is at: the shown highlight nearest the top third of
  // the screen. Right after a jump from the panel, the highlight jumped to stays
  // "current" while it is still on screen (otherwise a neighbour a few lines
  // higher would win, and the panel would point at a different item than the one
  // just clicked).
  let jumpedId = null;
  let jumpedAt = 0;
  P.on("jumped", ({ id }) => { jumpedId = id; jumpedAt = Date.now(); scheduleProgress(); });
  P.on("cleared", () => { jumpedId = null; });

  function currentIdOf(marks) {
    if (jumpedId) {
      const m = marks.find((x) => x.dataset.scrId === jumpedId);
      const r = m && m.getBoundingClientRect();
      // The first 2s cover the smooth scroll on its way there.
      const onScreen = r && r.bottom > 0 && r.top < innerHeight;
      if (m && (onScreen || Date.now() - jumpedAt < 2000)) return jumpedId;
      jumpedId = null; // scrolled away from it: back to the normal rule
    }
    const target = innerHeight / 3;
    let best = null;
    let bestDist = Infinity;
    for (const m of marks) {
      const r = m.getBoundingClientRect();
      const dist = r.top <= target && r.bottom >= target ? 0 : Math.min(Math.abs(r.top - target), Math.abs(r.bottom - target));
      if (dist < bestDist) { best = m; bestDist = dist; }
    }
    return best ? best.dataset.scrId : null;
  }

  function getProgress() {
    const root = P.getRoot();
    const all = P.firstMarks(root);
    const marks = all.filter((m) => !P.isRoleHidden(m.dataset.scrRole)); // the shown ones
    const blocks = P.blocksIn(root);
    let wordsLeft = 0;
    let passed = 0;
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (r.top >= innerHeight) wordsLeft += countWords(b); // still below the screen
      if (r.bottom <= innerHeight) passed++;                // scrolled to (or past) it
    }
    // keyOf() searches the page, so work it out once per highlight (not once per use).
    const seenSet = new Set(all.filter((m) => seen.has(keyOf(m))));
    return {
      keySeen: marks.filter((m) => seenSet.has(m)).length,
      keyTotal: marks.length,
      minutesLeft: Math.ceil(wordsLeft / WORDS_PER_MINUTE),
      percent: blocks.length ? Math.round((passed / blocks.length) * 100) : 0,
      // For the panel's key points list (checkmarks and "you are here"):
      seenIds: [...seenSet].map((m) => m.dataset.scrId),
      currentId: currentIdOf(marks),
    };
  }

  // Only talk to the panel once this page has been analyzed or set up for reading.
  function hasContent() {
    return P.blocksIn(P.getRoot()).length > 0 || P.firstMarks().length > 0;
  }

  let lastSent = 0;
  let progressTimer = 0;
  function sendProgressNow() {
    clearTimeout(progressTimer);
    progressTimer = 0;
    lastSent = Date.now();
    if (hasContent()) P.notifyPanel({ type: "PROGRESS", ...getProgress() });
  }

  // At most one PROGRESS every 500ms (the last one is never dropped).
  function scheduleProgress() {
    if (progressTimer) return;
    const wait = Math.max(0, 500 - (Date.now() - lastSent));
    progressTimer = setTimeout(sendProgressNow, wait);
  }

  // capture: also catches scrolling inside the reading view, which doesn't bubble.
  document.addEventListener("scroll", () => { if (hasContent()) scheduleProgress(); }, { capture: true, passive: true });

  // Eye buttons, density or the master switch changed which key points count.
  P.on("roles", () => { if (hasContent()) scheduleProgress(); });

  P.on("highlights", () => {
    observeMarks();
    if (isFocusMode()) setFocusMode(true);
    sendProgressNow();
  });

  // CLEAR (or a new analysis, which clears first): let go of the old marks and
  // tell the panel there are no key points any more. The timer runs after the
  // marks are gone; a new analysis sends its own PROGRESS right away instead.
  P.on("cleared", () => {
    if (observer) { observer.disconnect(); observer = null; }
    scheduleProgress();
  });

  // ======================================================================
  // 6. Shared with content.js / speech.js
  // ======================================================================
  // GET_PAGE_STATE: no progress at all on a page that was never analyzed or set up.
  const pageProgress = () => (hasContent() ? getProgress() : null);
  Object.assign(P, { isReaderOpen, getProgress: pageProgress, setActiveBlock, isFocusMode });
})();
