// "Key points" card: an outline of every highlight on the page, in document order.
// Clicking an item asks the page to jump to that sentence (JUMP_TO). The page tells
// us what is painted with HIGHLIGHTS_STATE, and where the reader is with PROGRESS
// (seenIds / currentId). Spec: docs/ACCESSIBILITY.md, "Key points list".
// Uses helpers from sidepanel.js ($, pageCall, onPageMessage, renderHighlightState...).

(function () {
  const list = $("kp-list");
  const body = $("kp-body");
  const empty = $("kp-empty");
  const countEl = $("kp-count");
  const filtersEl = $("kp-filters");
  const statusEl = $("kp-status");

  const ROLE = Object.fromEntries(SCR_ROLES.map((r) => [r.key, r]));
  const CUES = self.SCR_ROLE_UNDERLINES || {};

  let items = [];              // [{id, role, text}] from the page, in document order
  let hidden = new Set();      // roles that are not shown on the page right now
  let seen = new Set();        // ids the reader has already scrolled past
  let currentId = null;        // the item the reader is at ("you are here")
  let filter = "all";          // panel-only filter: "all" or a role key
  let tabStopKey = null;       // roving tabindex: which item is the list's one Tab stop
  let lastTouch = 0;           // when the reader last used the list (see autoScroll)

  // Items are matched across updates by role + sentence (+ which repeat of it),
  // not by id: the page gives new ids when it re-paints (reading view open/close),
  // and we want to keep the same buttons (and keyboard focus) when that happens.
  const rows = new Map();      // key -> <li>

  function keysFor(list) {
    const n = {};
    return list.map((it) => {
      const base = `${it.role}|${it.text}`;
      n[base] = (n[base] || 0) + 1;
      return `${base}|${n[base]}`;
    });
  }

  // ---------- Filter chips (radio group) ----------
  const FILTERS = [{ key: "all", label: "All" }, ...SCR_ROLES.map((r) => ({ key: r.key, label: r.label }))];
  const chips = {};
  for (const f of FILTERS) {
    const label = document.createElement("label");
    label.className = "chip";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "kp-filter";
    input.value = f.key;
    input.checked = f.key === filter;
    input.addEventListener("change", () => setFilter(f.key));
    const face = document.createElement("span");
    face.className = "chip-face";
    if (f.key !== "all") {
      face.style.setProperty("--c", `var(--role-${f.key})`);
      const dot = document.createElement("span");
      dot.className = "chip-dot";
      dot.setAttribute("aria-hidden", "true");
      face.append(dot);
    }
    const text = document.createElement("span");
    text.textContent = f.label;
    text.setAttribute("aria-hidden", "true"); // the input's aria-label already says it
    const count = document.createElement("span");
    count.className = "chip-count";
    count.setAttribute("aria-hidden", "true"); // the input's aria-label says it in words
    face.append(text, count);
    label.append(input, face);
    filtersEl.append(label);
    chips[f.key] = { input, count, label: f.label };
  }

  function renderChips() {
    const counts = { all: items.length };
    items.forEach((it) => (counts[it.role] = (counts[it.role] || 0) + 1));
    for (const [key, chip] of Object.entries(chips)) {
      const n = counts[key] || 0;
      chip.count.textContent = n;
      chip.input.disabled = key !== "all" && n === 0; // nothing to show for that role
      chip.input.setAttribute("aria-label", `${chip.label}, ${n} key point${n === 1 ? "" : "s"}`);
    }
    // The chosen role has no items any more (a new analysis): back to "All".
    if (chips[filter].input.disabled) setFilter("all");
    chips[filter].input.checked = true;
  }

  function setFilter(key) {
    filter = key;
    chips[key].input.checked = true;
    applyFilter();
  }

  // ---------- The list ----------
  function buildRow(key) {
    const li = document.createElement("li");
    li.dataset.key = key;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kp-item";
    btn.tabIndex = -1;
    btn.innerHTML =
      '<span class="kp-head">' +
        '<span class="kp-swatch" aria-hidden="true"></span>' +
        '<span class="kp-role"></span>' +
        '<span class="kp-flag">(hidden)</span>' +
        '<span class="kp-seen" aria-hidden="true">✓</span>' +
      "</span>" +
      '<span class="kp-text"></span>';
    btn.addEventListener("click", () => jump(li));
    li.append(btn);
    return li;
  }

  // Fill one row from its item (role, sentence, seen, hidden, current).
  function paintRow(li, it) {
    const btn = li.firstElementChild;
    const role = ROLE[it.role] || { label: "Highlight" };
    const cue = CUES[it.role] || {};
    li.dataset.id = it.id;
    li.dataset.role = it.role;
    btn.style.setProperty("--c", `var(--role-${it.role})`);
    btn.style.setProperty("--cue-style", cue.style || "solid");
    btn.style.setProperty("--cue-width", cue.thickness || "2px");
    btn.querySelector(".kp-role").textContent = role.label;
    btn.querySelector(".kp-text").textContent = it.text;
    paintState(li);
  }

  // The parts that change while reading: seen, hidden, current.
  function paintState(li) {
    const btn = li.firstElementChild;
    const id = li.dataset.id;
    const isSeen = seen.has(id);
    const isHidden = hidden.has(li.dataset.role);
    const role = ROLE[li.dataset.role] || { label: "Highlight" };
    btn.classList.toggle("is-hidden", isHidden);
    btn.querySelector(".kp-flag").hidden = !isHidden;
    btn.querySelector(".kp-seen").hidden = !isSeen;
    if (id === currentId) btn.setAttribute("aria-current", "location");
    else btn.removeAttribute("aria-current");
    // The visible text is clamped to 3 lines; the accessible name has all of it.
    const text = btn.querySelector(".kp-text").textContent;
    btn.setAttribute("aria-label",
      `${role.label}${isHidden ? " (hidden)" : ""}: ${text}${isSeen ? ", already seen" : ""}`);
  }

  function render() {
    const keys = keysFor(items);
    const hadFocus = list.contains(document.activeElement)
      ? document.activeElement.closest("li").dataset.key : null;
    // Remember where that row was, in case it disappears from the list.
    const hadFocusIndex = hadFocus ? visibleRows().indexOf(rows.get(hadFocus)) : -1;

    // Reuse rows we already have; drop the ones that are gone.
    const next = keys.map((key, i) => {
      const li = rows.get(key) || buildRow(key);
      paintRow(li, items[i]);
      return li;
    });
    rows.clear();
    keys.forEach((k, i) => rows.set(k, next[i]));
    // Only touch the DOM when the order or set changed (keeps focus in place).
    const sameOrder = next.length === list.children.length && next.every((li, i) => list.children[i] === li);
    if (!sameOrder) list.replaceChildren(...next);

    countEl.textContent = items.length ? ` (${items.length})` : "";
    empty.hidden = items.length > 0;
    body.hidden = items.length === 0;
    if (!items.length) setKpStatus("");
    renderChips();
    applyFilter();
    // Moving rows around drops keyboard focus; put it back on the same item.
    if (hadFocus && !list.contains(document.activeElement)) {
      // Same item if it still exists; otherwise the row now in its place (or the last one),
      // so keyboard focus never falls back to <body>.
      const shown = visibleRows();
      const target = rows.has(hadFocus) && !rows.get(hadFocus).hidden
        ? rows.get(hadFocus)
        : shown[Math.min(Math.max(hadFocusIndex, 0), shown.length - 1)];
      if (target) target.firstElementChild.focus({ preventScroll: true });
      else document.getElementById("kp-title")?.focus?.({ preventScroll: true });
    }
  }

  // Show only the chosen role (or everything), and keep one Tab stop that is visible.
  function applyFilter() {
    for (const li of rows.values()) li.hidden = filter !== "all" && li.dataset.role !== filter;
    const shown = visibleRows();
    let stop = rows.get(tabStopKey);
    if (!stop || stop.hidden) {
      stop = shown.find((li) => li.dataset.id === currentId) || shown[0] || null;
    }
    setTabStop(stop);
  }

  const visibleRows = () => [...list.children].filter((li) => !li.hidden);

  function setTabStop(li) {
    tabStopKey = li ? li.dataset.key : null;
    for (const row of rows.values()) row.firstElementChild.tabIndex = row === li ? 0 : -1;
  }

  // ---------- Keyboard: Up / Down / Home / End move; Enter / Space jump (native button) ----------
  list.addEventListener("keydown", (e) => {
    const li = e.target.closest && e.target.closest("li");
    if (!li) return;
    const shown = visibleRows();
    const i = shown.indexOf(li);
    let j = null;
    if (e.key === "ArrowDown") j = Math.min(shown.length - 1, i + 1);
    else if (e.key === "ArrowUp") j = Math.max(0, i - 1);
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = shown.length - 1;
    if (j == null) return;
    e.preventDefault(); // don't scroll the panel
    setTabStop(shown[j]);
    shown[j].firstElementChild.focus();
  });

  // "Touching" the list: never auto-scroll it for 5s after that (see autoScroll).
  ["pointerdown", "wheel", "touchstart", "keydown", "focusin"].forEach((type) =>
    list.addEventListener(type, () => { lastTouch = Date.now(); }, { passive: true }));

  // ---------- Jumping ----------
  // Status line under the list: errors are cleared when the list changes (the
  // highlight may be back), notes about a changed setting stay until the next jump.
  let statusIsError = false;
  function setKpStatus(text, isError = false) {
    statusEl.textContent = text;
    statusIsError = isError && !!text;
  }

  // What the page had to change so the sentence can be seen. A saved setting must
  // never change silently, so we say what changed and where to set it back.
  function revealNote(r) {
    if (!r || !(r.master || r.eye || r.density)) return "";
    const role = (ROLE[r.role] || { label: "Highlight" }).label;
    let note = `Showing ${role} highlights again so you can see this one.`;
    if (r.master) note += " Highlights on the page are switched on again (the “Show” switch).";
    if (r.density && r.density.to) {
      const d = SCR_DENSITY[r.density.to] || { label: r.density.to };
      note += ` “Highlights to show” is now ${d.label}` +
        (r.density.presetWas && r.density.presetWas !== "custom" ? ", and the reading preset is now Custom." : ".");
    }
    return note;
  }

  function keyParts(key) {
    // key = role|text|n (the sentence itself may contain "|")
    const first = key.indexOf("|");
    const last = key.lastIndexOf("|");
    return { role: key.slice(0, first), text: key.slice(first + 1, last), n: Number(key.slice(last + 1)) || 1 };
  }

  async function jump(li) {
    lastTouch = Date.now();
    setTabStop(li);
    setKpStatus("");
    const key = li.dataset.key;
    const wasHidden = hidden.has(li.dataset.role);
    const before = currentId;
    // Show "you are here" right away; the page's next PROGRESS confirms it.
    currentId = li.dataset.id;
    for (const row of rows.values()) paintState(row);
    // Keyboard focus stays on this button: the page's focus is in another document.
    // Role + sentence go along with the id: if the page re-painted just now (reading
    // view opening or closing), the id is stale and the page finds it by those.
    let res = await pageCall({ type: "JUMP_TO", id: li.dataset.id, ...keyParts(key) });
    if (!res.ok && /no longer on the page/i.test(res.error || "")) {
      // Our ids may be behind the page's: ask for the current list and try once more.
      const state = await pageCall({ type: "GET_PAGE_STATE" });
      if (state.ok && state.highlights) {
        applyHighlights(state.highlights);
        const row = rows.get(key);
        if (row) res = await pageCall({ type: "JUMP_TO", id: row.dataset.id, ...keyParts(key) });
      }
    }
    if (!res.ok) {
      // Undo "you are here": we didn't get there.
      if (currentId === li.dataset.id) currentId = before;
      for (const row of rows.values()) paintState(row);
      setKpStatus(res.error && /no longer on the page/i.test(res.error)
        ? res.error : friendlyError(res.error || "Couldn't jump to that sentence."), true);
      return;
    }
    if (res.id && res.id !== currentId) {
      // The page found it under a newer id: follow it (HIGHLIGHTS_STATE confirms).
      const row = rows.get(key);
      if (row) row.dataset.id = res.id;
      currentId = res.id;
      for (const row of rows.values()) paintState(row);
    }
    // The page showed a hidden role again: say so, and bring the legend's eye
    // buttons and the master switch up to date too.
    if (wasHidden || res.revealed) {
      setKpStatus(revealNote(res.revealed));
      const state = await pageCall({ type: "GET_PAGE_STATE" });
      if (state.ok) renderHighlightState(state);
      if (self.scrClearSpeechError) scrClearSpeechError(); // "Highlights are hidden" no longer applies
    }
  }

  // ---------- Following the reader ----------
  // Scroll the current item into view inside the list, but only when the reader
  // hasn't used the list in the last 5 seconds: never pull it away from under them.
  function autoScroll() {
    if (Date.now() - lastTouch < 5000) return;
    const li = [...rows.values()].find((r) => r.dataset.id === currentId && !r.hidden);
    if (!li || list.scrollHeight <= list.clientHeight) return;
    const top = li.offsetTop;
    const bottom = top + li.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }

  function applyHighlights(m) {
    items = (m && m.items) || [];
    hidden = new Set((m && m.hiddenRoles) || []);
    if (!items.length) { seen = new Set(); currentId = null; }
    if (statusIsError) setKpStatus(""); // the list changed: an old error may no longer apply
    render();
  }

  onPageMessage("HIGHLIGHTS_STATE", applyHighlights);

  onPageMessage("PROGRESS", (p) => {
    seen = new Set((p && p.seenIds) || []);
    currentId = (p && p.currentId) || null;
    for (const row of rows.values()) paintState(row);
    autoScroll();
  });

  render();
})();
