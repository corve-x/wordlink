(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* private mode */
      }
    },
  };

  let pid = store.get("wl-player");
  if (!pid) {
    pid =
      window.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : Array.from({ length: 4 }, () =>
            Math.random().toString(16).slice(2, 10),
          ).join("");
    store.set("wl-player", pid);
  }

  async function api(path, opts = {}) {
    const res = await fetch("/api" + path, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers: { "X-Player-Id": pid, "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  const entry = $("#entry"),
    rowsEl = $("#rows"),
    msgEl = $("#msg");
  let mode = store.get("wl-mode") === "free" ? "free" : "daily";
  let game = null,
    fetchedAt = 0,
    busy = false,
    startPending = false,
    msgTimer = 0;
  const drafts = {}; // typed-but-unsubmitted letters, per game and row

  const clean = (s) => (s || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  const dkey = () => game.id + ":" + game.current.index;
  const active = () => game && game.status === "active";
  const fmt = (ms) => {
    const s = Math.floor(ms / 1000),
      h = Math.floor(s / 3600),
      m = Math.floor(s / 60) % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return (h ? h + ":" : "") + pad(m) + ":" + pad(s % 60);
  };
  const elapsed = () =>
    !game.started
      ? 0
      : game.elapsed_ms + (active() ? Date.now() - fetchedAt : 0);

  function flash(text) {
    msgEl.textContent = text;
    clearTimeout(msgTimer);
    if (text)
      msgTimer = setTimeout(() => {
        msgEl.textContent = "";
      }, 1800);
  }

  // ---------- state ----------
  function setGame(g) {
    const same =
      game &&
      game.id === g.id &&
      game.status === g.status &&
      (g.current && game.current
        ? g.current.index === game.current.index &&
          g.current.fixed === game.current.fixed
        : !g.current && !game.current);
    game = g;
    fetchedAt = Date.now();
    if (same) tick();
    else render();
  }

  async function load() {
    const m = mode;
    try {
      const { game: g } = await api("/state?mode=" + m);
      if (m === mode) setGame(g);
    } catch {
      flash("Cannot reach the game server.");
    }
  }

  function setMode(m) {
    if (m === mode) return;
    mode = m;
    store.set("wl-mode", m);
    flash("");
    load();
  }

  // ---------- rendering ----------
  const slotsOf = (word, cls = "") =>
    [...word].map((c) => `<span class="slot ${cls}">${c}</span>`).join("");

  function render() {
    document
      .querySelectorAll(".tabs button")
      .forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.mode === mode)),
      );
    rowsEl.innerHTML = "";
    for (let i = 0; i < 6; i++) {
      const li = document.createElement("li");
      li.className = "row";
      if (i < game.solved.length) {
        li.classList.add(i === 0 ? "given" : "solved");
        li.innerHTML = `<span aria-hidden="true" style="display:contents">${slotsOf(game.solved[i])}</span><span class="sr">${game.solved[i]}</span>`;
      } else if (active() && i === game.current.index) {
        li.id = "active-row";
        li.classList.add("active");
      } else {
        li.classList.add("hidden");
        li.innerHTML =
          '<span class="conceal" aria-hidden="true"></span><span class="sr">Hidden word</span>';
      }
      rowsEl.appendChild(li);
    }
    if (active()) {
      const { length, fixed, index } = game.current;
      entry.hidden = false;
      entry.maxLength = length - fixed.length;
      const draft = drafts[dkey()] || "";
      if (entry.value !== draft) entry.value = draft;
      entry.setAttribute(
        "aria-label",
        `Word ${index + 1} of 6, ${length} letters, starts with ${fixed[0]}. Type the missing letters.`,
      );
      placeEntry();
      paint();
      if (
        !store.focusedOnce &&
        window.matchMedia &&
        matchMedia("(hover: hover)").matches
      ) {
        store.focusedOnce = true;
        entry.focus();
      }
    } else {
      entry.hidden = true;
      entry.blur();
    }
    $("#hints").hidden = !active();
    $("#replace-chain").hidden = game.mode !== "free" || !active();
    const restartDialog = $("#restart-dialog");
    const replaceButton = $("#replace-chain");

    replaceButton.addEventListener("click", async () => {
      if (busy || mode !== "free" || game?.mode !== "free" || !active()) return;

      const previousId = game.id;
      const draftKey = dkey();

      // Reset the previous choice so Escape always means "keep playing".
      restartDialog.returnValue = "cancel";
      restartDialog.showModal();
      await new Promise((resolve) => {
        restartDialog.addEventListener("close", resolve, { once: true });
      });

      if (restartDialog.returnValue !== "restart") return;
      if (mode !== "free" || game.id !== previousId || !active()) return;

      replaceButton.disabled = true;
      try {
        const result = await api(
          "/free/new?replace_id=" + encodeURIComponent(previousId),
          { method: "POST" },
        );

        delete drafts[draftKey];
        if (mode === "free" && game.id === previousId) {
          setGame(result.game);
          flash("");
          entry.focus();
        }
      } catch {
        flash("Could not load a new chain. Try again.");
      } finally {
        replaceButton.disabled = false;
      }
    });

    const done = !active();
    $("#after").hidden = !done;
    if (done) {
      const h = game.hints_used;
      $("#summary").textContent =
        `Solved in ${fmt(game.elapsed_ms)}, ${h ? h + (h === 1 ? " hint" : " hints") : "no hints"}.` +
        (mode === "daily" ? " The next puzzle arrives at midnight IST." : "");
      $("#new-chain").hidden = mode !== "free";
    }
    tick();
  }

  function placeEntry() {
    const row = $("#active-row");
    if (!row) return;
    Object.assign(entry.style, {
      top: row.offsetTop + "px",
      left: row.offsetLeft + "px",
      width: row.offsetWidth + "px",
      height: row.offsetHeight + "px",
    });
  }

  function paint() {
    const row = $("#active-row");
    if (!row || !active()) return;
    const { length, fixed } = game.current;
    const v = entry.value,
      focused = document.activeElement === entry;
    const s = entry.selectionStart ?? v.length,
      e = entry.selectionEnd ?? v.length;
    let html = "";
    for (let i = 0; i < length; i++) {
      if (i < fixed.length) {
        html += `<span class="slot fixed">${fixed[i]}</span>`;
        continue;
      }
      const j = i - fixed.length;
      const cls =
        (focused && e > s && j >= s && j < e ? " sel" : "") +
        (focused && s === e && j === s ? " caret" : "");
      html += `<span class="slot${cls}">${v[j] || ""}</span>`;
    }
    row.innerHTML = html;
  }

  function tick() {
    if (!game) return;
    $("#timer").textContent = fmt(elapsed());
    if (!active()) return;
    const dt = game.hints.running ? Date.now() - fetchedAt : 0;
    const left = (ms) => Math.max(0, Math.ceil((ms - dt) / 1000));
    for (const [id, label, ms] of [
      ["#hint-letter", "Reveal a letter", game.hints.letter_ms],
      ["#hint-word", "Reveal word", game.hints.word_ms],
    ]) {
      const n = left(ms),
        b = $(id);
      b.textContent = n > 0 ? `${label} · ${n}s` : label;
      b.disabled = !game.hints.running || n > 0;
    }
  }

  // ---------- typing ----------
  async function ensureStarted() {
    if (game.started || startPending) return;
    startPending = true;
    const g = game;
    g.started = true;
    g.elapsed_ms = 0;
    fetchedAt = Date.now(); // show time running immediately
    g.hints = { running: true, letter_ms: 15000, word_ms: 60000 };
    tick();
    try {
      const { game: s } = await api(`/games/${g.id}/start`, { method: "POST" });
      if (
        game &&
        game.id === s.id &&
        s.current &&
        game.current &&
        s.current.index === game.current.index
      ) {
        game.elapsed_ms = s.elapsed_ms;
        game.hints = s.hints;
        fetchedAt = Date.now();
        tick();
      }
    } catch {
      /* the first guess will start the clock server-side anyway */
    }
    startPending = false;
  }

  function onValue() {
    const v = clean(entry.value).slice(0, entry.maxLength);
    if (v !== entry.value) entry.value = v;
    drafts[dkey()] = v;
    if (v) ensureStarted();
    paint();
    if (v.length === entry.maxLength) submit(game.current.fixed + v);
  }

  async function submit(full) {
    if (busy) return;
    busy = true;
    const g = game,
      key = dkey();
    try {
      const res = await api(`/games/${g.id}/guess`, { body: { guess: full } });
      if (game.id !== g.id) return;
      if (res.correct) {
        delete drafts[key];
        flash("");
        setGame(res.game);
      } else {
        setGame(res.game);
        flash("Not quite. Try again.");
        const row = $("#active-row");
        if (row) {
          row.classList.remove("shake");
          void row.offsetWidth;
          row.classList.add("shake");
        }
        entry.focus();
        entry.select();
        paint();
      }
    } catch {
      flash("Could not check that guess. Try again.");
    } finally {
      busy = false;
    }
  }

  entry.addEventListener("input", onValue);
  entry.addEventListener("paste", (e) => {
    e.preventDefault();
    if (!active() || busy) return;
    const raw = clean(
      (e.clipboardData || window.clipboardData).getData("text"),
    );
    if (!raw) return;
    const { length, fixed } = game.current,
      max = entry.maxLength;
    if (raw.length === length && raw.startsWith(fixed))
      entry.value = raw.slice(fixed.length); // whole answer
    else if (raw.length === length) {
      // whole answer with the wrong start: still a guess
      entry.value = raw.slice(fixed.length);
      drafts[dkey()] = entry.value;
      ensureStarted();
      paint();
      submit(raw);
      return;
    } else if (raw.length === max)
      entry.value = raw; // missing letters
    else {
      const s = entry.selectionStart,
        t = entry.selectionEnd;
      entry.value = entry.value.slice(0, s) + raw + entry.value.slice(t);
    }
    onValue();
  });
  entry.addEventListener("pointerup", () =>
    setTimeout(
      () => entry.setSelectionRange(entry.value.length, entry.value.length),
      0,
    ),
  );
  for (const ev of ["focus", "blur", "keyup"])
    entry.addEventListener(ev, paint);
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === entry) paint();
  });
  window.addEventListener("resize", placeEntry);

  // ---------- hints, modes, new chain ----------
  async function useHint(kind) {
    const g = game,
      had = document.activeElement === entry;
    try {
      const res = await api(`/games/${g.id}/hint`, { body: { kind } });
      if (game.id !== g.id) return;
      flash("");
      if (res.ok) {
        delete drafts[g.id + ":" + g.current.index];
        entry.value = "";
      } // slots shifted: start the row's typing fresh
      setGame(res.game);
      if (had || res.ok) {
        if (active()) entry.focus();
      }
    } catch {
      flash("Could not reveal a hint. Try again.");
    }
  }
  $("#hint-letter").addEventListener("click", () => useHint("letter"));
  $("#hint-word").addEventListener("click", () => useHint("word"));
  document
    .querySelectorAll(".tabs button")
    .forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#new-chain").addEventListener("click", async () => {
    try {
      const { game: g } = await api("/free/new", { method: "POST" });
      flash("");
      setGame(g);
    } catch {
      flash("Could not load a new chain.");
    }
  });

  // ---------- theme, dialogs, history ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    $("#theme").setAttribute(
      "aria-label",
      t === "dark" ? "Switch to light mode" : "Switch to dark mode",
    );
  }
  applyTheme(
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  $("#theme").addEventListener("click", () => {
    const t =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(t);
    store.set("wl-theme", t);
  });

  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => {
      if (e.target === d || e.target.hasAttribute("data-close")) d.close();
    });
  });
  $("#open-about").addEventListener("click", () => $("#about").showModal());
  $("#open-history").addEventListener("click", async () => {
    const list = $("#hist-list");
    list.innerHTML = '<li class="empty">Loading…</li>';
    $("#history").showModal();
    try {
      const { history } = await api("/history");
      if (!history.length) {
        list.innerHTML = '<li class="empty">No finished rounds yet.</li>';
        return;
      }
      list.innerHTML = "";
      for (const h of history) {
        const li = document.createElement("li");
        const when = new Date(h.finished_at).toLocaleString([], {
          dateStyle: "medium",
          timeStyle: "short",
        });
        const n = h.hints_used;
        li.innerHTML =
          `<div class="seq">${h.words.join('<i aria-hidden="true">→</i>')}</div>` +
          `<div class="meta">${h.mode === "daily" ? "Daily" : "Free play"}, ${when}, ${fmt(h.elapsed_ms)}, ${n ? n + (n === 1 ? " hint" : " hints") : "no hints"}</div>`;
        list.appendChild(li);
      }
    } catch {
      list.innerHTML = '<li class="empty">Could not load history.</li>';
    }
  });

  // ---------- lifecycle ----------
  setInterval(tick, 500);
  setInterval(() => {
    if (document.visibilityState === "visible" && !busy) load();
  }, 60000); // picks up the midnight IST rollover
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") load();
  });
  load();
})();
