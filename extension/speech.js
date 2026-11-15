// Read aloud, sentence by sentence, with the browser's built-in speechSynthesis.
// Builds on self.SCR_PAGE from content.js. Spec: docs/ACCESSIBILITY.md, item 11.
//
// Why one utterance per sentence? Chrome silently stops long utterances after
// about 15 seconds, and per-sentence utterances also let us outline exactly
// the sentence being read and offer next / previous.

(function () {
  if (self.__scrSpeechLoaded) return; // guard against double injection
  self.__scrSpeechLoaded = true;

  const P = self.SCR_PAGE;
  // Looked up on every use rather than saved once, so a test can swap in a fake.
  const synth = () => self.speechSynthesis;

  let queue = [];          // [{ text, marks: [<mark>] | null, block: Element | null }]
  let index = 0;           // which sentence (0-based)
  let state = "stopped";   // "playing" | "paused" | "stopped"
  let rate = 1;
  let voiceURI = "";
  // Every utterance gets a ticket. Cancelling one still fires its "end" event in
  // Chrome, so we only react to events from the newest ticket.
  let ticket = 0;

  // ---------- Building the queue ----------

  function splitSentences(text) {
    if (self.Intl && Intl.Segmenter) {
      let segmenter;
      try {
        segmenter = new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: "sentence" });
      } catch (e) {
        segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" }); // bad lang tag on the page
      }
      return [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
    }
    // Fallback: up to and including . ! or ? (plus closing quotes/brackets).
    return (text.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g) || []).map((s) => s.trim()).filter(Boolean);
  }

  // scope = "highlights": the highlighted sentences, in document order.
  function highlightQueue(root) {
    P.ensureBlocks(root); // so focus mode can follow along block by block
    return P.firstMarks(root)
      .filter((m) => !P.isRoleHidden(SCR.roleOf(m)))
      .map((first) => {
        const marks = P.marksFor(SCR.idOf(first));
        const text = SCR.normalize(marks.map((m) => m.textContent).join(""));
        return { text, marks, block: first.closest(".scr-block") };
      });
  }

  // scope = "article": every block, split into sentences.
  function articleQueue(root) {
    return P.ensureBlocks(root).flatMap((block) =>
      splitSentences(SCR.normalize(block.textContent || "")).map((text) => ({ text, marks: null, block }))
    );
  }

  // ---------- Showing where we are ----------

  function clearOutline() {
    document.querySelectorAll(".scr-speaking").forEach((el) => el.classList.remove("scr-speaking"));
  }

  function isOffScreen(el) {
    const r = el.getBoundingClientRect();
    return r.bottom < 0 || r.top > innerHeight;
  }

  function showItem(item) {
    clearOutline();
    const targets = item.marks || (item.block ? [item.block] : []);
    targets.forEach((el) => el.classList.add("scr-speaking"));
    if (item.block && P.isFocusMode && P.isFocusMode()) P.setActiveBlock(item.block);
    const first = targets[0];
    if (first && isOffScreen(first)) {
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      first.scrollIntoView({ block: "center", behavior: reduce ? "instant" : "smooth" });
    }
  }

  function getSpeechState() {
    const item = queue[index];
    return { state, index, total: queue.length, text: item && state !== "stopped" ? item.text : "" };
  }

  // `error` (optional) tells the panel why reading stopped on its own.
  function setState(next, error) {
    state = next;
    P.notifyPanel({ type: "SPEECH_STATE", ...getSpeechState(), ...(error ? { error } : {}) });
  }

  // What to tell the reader when the browser's voice fails.
  function errorText(code) {
    if (code === "not-allowed") return "Chrome blocked the voice. Click once on the page, then press Read aloud again.";
    if (code === "voice-unavailable" || code === "language-unavailable") return "That voice isn't available. Pick another voice and try again.";
    if (code === "audio-busy" || code === "audio-hardware") return "Couldn't play sound. Check your audio output and try again.";
    return "Couldn't start the voice. Try again, or pick another voice.";
  }

  // ---------- Speaking ----------

  function findVoice() {
    if (!voiceURI) return null;
    return synth().getVoices().find((v) => v.voiceURI === voiceURI) || null;
  }

  function speakCurrent() {
    const myTicket = ++ticket;
    synth().cancel(); // drop whatever was still speaking
    const item = queue[index];
    showItem(item);

    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.rate = rate;
    const voice = findVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else if (document.documentElement.lang) {
      utterance.lang = document.documentElement.lang;
    }
    utterance.onend = () => {
      if (myTicket !== ticket || state !== "playing") return; // an old, cancelled utterance
      if (index < queue.length - 1) {
        index++;
        speakCurrent();
      } else {
        stop(); // reached the end
      }
    };
    utterance.onerror = (e) => {
      if (myTicket !== ticket || e.error === "interrupted" || e.error === "canceled") return;
      console.warn("[SCR] speech error", e.error);
      stop({ error: errorText(e.error) });
    };
    synth().speak(utterance);
    setState("playing");
  }

  function start({ scope, rate: r, voice }) {
    if (!synth()) return { ok: false, error: "Read aloud isn't available in this browser." };
    const root = P.getRoot();
    const items = scope === "article" ? articleQueue(root) : highlightQueue(root);
    if (!items.length) {
      if (scope === "article") return { ok: false, error: "Couldn't find an article on this page." };
      // The page is highlighted, but nothing is shown: say why instead of "No highlights yet".
      if (P.firstMarks(root).length) {
        const off = document.documentElement.classList.contains("scr-hidden");
        return { ok: false, error: off ? "Highlights are switched off" : "Highlights are hidden" };
      }
      return { ok: false, error: "No highlights yet" };
    }
    queue = items;
    index = 0;
    rate = Number(r) > 0 ? Number(r) : 1;
    voiceURI = voice || "";
    speakCurrent();
    return { ok: true, total: queue.length };
  }

  // Pause = cancel and remember the sentence; resume = say that sentence again.
  // speechSynthesis.pause() is unreliable in Chrome (some voices ignore it, and a
  // long pause can freeze the engine), and restarting a short sentence is fine.
  function pause() {
    if (state !== "playing") return;
    ticket++;
    synth().cancel();
    setState("paused");
  }

  function resume() {
    if (state === "paused") speakCurrent();
  }

  // force: always tell the panel (the Stop button uses it, so the panel can
  // always get back in sync even if it missed a message).
  function stop({ error = "", force = false } = {}) {
    ticket++;
    if (synth()) synth().cancel();
    clearOutline();
    const wasStopped = state === "stopped" && !queue.length;
    queue = [];
    index = 0;
    if (!wasStopped || force || error) setState("stopped", error);
  }

  function move(step) {
    if (!queue.length) return;
    index = Math.min(queue.length - 1, Math.max(0, index + step));
    if (state === "playing") {
      speakCurrent();
    } else {
      showItem(queue[index]); // paused: move the outline, stay paused
      setState("paused");
    }
  }

  // ---------- Messages and lifecycle ----------

  P.handlers.SPEAK = (msg) => start(msg);

  P.handlers.SPEECH_CONTROL = (msg) => {
    const actions = { pause, resume, stop: () => stop({ force: true }), next: () => move(1), prev: () => move(-1) };
    const action = actions[msg.action];
    if (!action) return { ok: false, error: `Unknown action: ${msg.action}` };
    action();
    return { ok: true };
  };

  // Speed and voice changes in the panel apply from the next sentence on.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.reading) return;
    const r = changes.reading.newValue || {};
    if (Number(r.speechRate) > 0) rate = Number(r.speechRate);
    if (typeof r.speechVoice === "string") voiceURI = r.speechVoice;
  });

  // The sentences we were reading are gone or about to move: stop.
  P.on("cleared", () => stop());
  P.on("root", () => stop());
  addEventListener("pagehide", () => stop());

  P.getSpeechState = getSpeechState;
})();
