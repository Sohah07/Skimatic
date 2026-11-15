// "Reading comfort" card: presets, clean reading view, text settings, focus mode, density.
// Settings live in chrome.storage.sync "reading" (shared/reading-settings.js); the page
// applies them live via storage.onChanged. Also applies the reader's text settings to the
// panel itself. Uses helpers from sidepanel.js.

(function () {
  const TEXT_KEYS = ["font", "size", "letterSpacing", "wordSpacing", "lineHeight", "lineWidth", "theme"];
  const RANGE_FORMAT = {
    size:          { show: (v) => `${v} px`,                text: (v) => `${v} pixels` },
    letterSpacing: { show: (v) => `${(+v).toFixed(2)} em`,  text: (v) => `${(+v).toFixed(2)} em` },
    wordSpacing:   { show: (v) => `${(+v).toFixed(2)} em`,  text: (v) => `${(+v).toFixed(2)} em` },
    lineHeight:    { show: (v) => `${(+v).toFixed(2)}`,     text: (v) => `${(+v).toFixed(2)} times the text size` },
    lineWidth:     { show: (v) => `${v} ch`,                text: (v) => `${v} characters` },
  };

  let reading = { ...SCR_READING_DEFAULTS };
  let pending = null;     // patch not yet written to storage
  let saveTimer = null;

  // ---------- Preset matching ----------
  const same = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : a === b);
  function matchesPreset(r, name) {
    const p = SCR_READING_PRESETS[name];
    return !!p && Object.keys(p).every((k) => same(r[k], p[k]));
  }
  function presetOf(r) {
    if (r.preset !== "custom" && matchesPreset(r, r.preset)) return r.preset;
    return Object.keys(SCR_READING_PRESETS).find((p) => matchesPreset(r, p)) || "custom";
  }

  // ---------- Saving ----------
  // Manual changes: update local state + UI now, write to storage debounced (sliders
  // fire many input events; storage.sync has write quotas).
  function change(patch, { immediate = false } = {}) {
    reading = { ...reading, ...patch };
    reading.preset = presetOf({ ...reading, preset: "custom" });
    pending = { ...(pending || {}), ...patch, preset: reading.preset };
    render();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, immediate ? 0 : 200);
  }
  async function flush() {
    saveTimer = null;
    const patch = pending;
    pending = null;
    if (patch) {
      await scrSaveReading(patch);
      // Pages Skimatic already runs on follow storage.onChanged. The tab the reader is
      // on may not have our scripts yet: the background adds them if Chrome allows it.
      send({ type: "APPLY_READING" });
    }
  }
  self.scrReadingChange = change;          // listen-panel.js uses these
  self.scrReading = () => reading;

  // ---------- Build controls ----------
  const fontSelect = $("font");
  for (const [key, f] of Object.entries(SCR_FONTS)) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = f.label;
    fontSelect.append(o);
  }
  fontSelect.addEventListener("change", () => change({ font: fontSelect.value, enabled: true }));

  document.querySelectorAll('.comfort input[type="range"]').forEach((input) => {
    input.addEventListener("input", () => change({ [input.dataset.key]: +input.value, enabled: true }));
  });

  const themes = $("themes");
  for (const [key, t] of Object.entries(SCR_THEMES)) {
    const label = document.createElement("label");
    label.className = "theme";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "theme";
    input.value = key;
    input.addEventListener("change", () => input.checked && change({ theme: key, enabled: true }));
    const chip = document.createElement("span");
    chip.className = "theme-chip" + (t.bg ? "" : " theme-site");
    chip.setAttribute("aria-hidden", "true");
    chip.textContent = "Aa";
    if (t.bg) { chip.style.background = t.bg; chip.style.color = t.fg; }
    const text = document.createElement("span");
    text.className = "theme-label";
    text.textContent = t.label;
    label.append(input, chip, text);
    themes.append(label);
  }

  const density = $("density");
  for (const [key, d] of Object.entries(SCR_DENSITY)) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "density";
    input.value = key;
    input.addEventListener("change", () => input.checked && change({ density: key }, { immediate: true }));
    const span = document.createElement("span");
    span.textContent = d.label;
    label.append(input, span);
    density.append(label);
  }

  document.querySelectorAll('input[name="preset"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const p = input.value;
      change({ ...SCR_READING_PRESETS[p], preset: p }, { immediate: true });
    });
  });

  $("focus-mode").addEventListener("click", () =>
    change({ focusMode: !reading.focusMode }, { immediate: true })
  );

  $("reset-text").addEventListener("click", () => {
    const patch = { enabled: false };
    TEXT_KEYS.forEach((k) => (patch[k] = SCR_READING_DEFAULTS[k]));
    change(patch, { immediate: true });
  });

  // ---------- Clean reading view ----------
  const readerBtn = $("reader");
  let readerOpen = false;
  function renderReader(open) {
    readerOpen = !!open;
    readerBtn.textContent = readerOpen ? "Close reading view" : "Open clean reading view";
  }
  readerBtn.addEventListener("click", async () => {
    if (isBusy(readerBtn)) return;
    setBusy(readerBtn, true);
    const res = await pageCall({ type: "READER", action: readerOpen ? "close" : "open" });
    setBusy(readerBtn, false);
    if (res.ok) renderReader(res.open);
    else setStatus(friendlyError(res.error), "error");
  });
  onPageMessage("READER_STATE", (m) => renderReader(m && m.open));

  // ---------- Use on every website (opt-in) ----------
  // Off by default: Skimatic only runs on pages the reader points it at. Turning this on
  // asks Chrome for access to all sites (the permission prompt needs this click), then
  // the background registers the page scripts for every site. Off removes both.
  const ALL_SITES = ["http://*/*", "https://*/*"];
  const autoBtn = $("auto-apply");
  async function refreshAuto() {
    const res = await send({ type: "AUTO_APPLY_STATE" });
    setSwitch(autoBtn, !!(res.ok && res.data && res.data.on));
  }
  autoBtn.addEventListener("click", async () => {
    if (isBusy(autoBtn)) return;
    const on = !switchOn(autoBtn);
    setBusy(autoBtn, true);
    try {
      if (on) {
        let granted = false;
        try {
          granted = await chrome.permissions.request({ origins: ALL_SITES });
        } catch (e) {
          granted = false;
        }
        if (!granted) {
          setStatus("Skimatic wasn't allowed to read all sites, so this stays off.", "error");
          return;
        }
      }
      const res = await send({ type: "AUTO_APPLY", on });
      if (!res.ok) setStatus(friendlyError(res.error), "error");
      if (!on) await chrome.permissions.remove({ origins: ALL_SITES }).catch(() => {});
    } finally {
      setBusy(autoBtn, false);
      refreshAuto();
    }
  });
  refreshAuto();

  // ---------- Render ----------
  function render() {
    const preset = presetOf(reading);
    document.querySelectorAll('input[name="preset"]').forEach((i) => (i.checked = i.value === preset));
    $("preset-custom").hidden = preset !== "custom";
    document.querySelectorAll(".preset-desc").forEach((p) => (p.hidden = p.id !== `preset-desc-${preset}`));

    if (fontSelect.value !== reading.font) fontSelect.value = reading.font;
    for (const key of Object.keys(RANGE_FORMAT)) {
      const input = $(key);
      if (+input.value !== +reading[key]) input.value = reading[key];
      $(`${key}-out`).textContent = RANGE_FORMAT[key].show(reading[key]);
      input.setAttribute("aria-valuetext", RANGE_FORMAT[key].text(reading[key]));
    }
    document.querySelectorAll('input[name="theme"]').forEach((i) => (i.checked = i.value === reading.theme));
    document.querySelectorAll('input[name="density"]').forEach((i) => (i.checked = i.value === reading.density));
    $("text-off-hint").hidden = !!reading.enabled;
    setSwitch($("focus-mode"), !!reading.focusMode);
    setDensityRoles((SCR_DENSITY[reading.density] || SCR_DENSITY.all).roles);
    applyToPanel();
    if (self.scrRenderListenSettings) self.scrRenderListenSettings(reading);
  }

  // The reader's text settings, applied to the panel itself (only while they're on).
  function applyToPanel() {
    const root = document.documentElement.style;
    if (!reading.enabled) {
      ["--panel-font", "--panel-ls", "--panel-ws", "--panel-scale"].forEach((p) => root.removeProperty(p));
      return;
    }
    const stack = (SCR_FONTS[reading.font] || {}).stack;
    stack ? root.setProperty("--panel-font", stack) : root.removeProperty("--panel-font");
    root.setProperty("--panel-ls", `${reading.letterSpacing}em`);
    root.setProperty("--panel-ws", `${reading.wordSpacing}em`);
    root.setProperty("--panel-scale", String(Math.min(1.3, Math.max(0.9, reading.size / 20))));
  }

  // ---------- Load + follow changes made elsewhere (shortcut, another window) ----------
  scrLoadReading().then((r) => { reading = r; render(); });
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes.reading || pending || saveTimer) return;
      reading = { ...SCR_READING_DEFAULTS, ...(changes.reading.newValue || {}) };
      render();
    });
  }
  render();
})();
