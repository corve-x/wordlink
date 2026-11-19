const el = (id) => document.getElementById(id);
document.documentElement.dataset.theme =
  localStorage.getItem("wl-theme") ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
el("name").value = localStorage.getItem("wl-name") || "";

let token = sessionStorage.getItem("wl-race-token");
if (!token) {
  token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  sessionStorage.setItem("wl-race-token", token);
}
let code = sessionStorage.getItem("wl-room") || "";
let state = null;
let queue = Promise.resolve();
let pending = 0;

function reset() {
  code = "";
  state = null;
  sessionStorage.removeItem("wl-room");
  el("match").hidden = true;
  el("lobby").hidden = false;
  el("rows").replaceChildren();
}

function render(next) {
  const previous = state;
  state = next;
  code = next.code;
  sessionStorage.setItem("wl-room", code);
  el("lobby").hidden = true;
  el("match").hidden = false;
  el("room-code").textContent = code;
  const me = next.players.find((p) => p.you);
  el("players").replaceChildren(
    ...next.players.map((p) => {
      const item = document.createElement("li");
      const status =
        next.phase === "waiting"
          ? p.ready
            ? "Ready"
            : "In lobby"
          : p.score + "/" + next.total;
      item.textContent = p.name + (p.you ? " (you)" : "") + " · " + status;
      return item;
    }),
  );
  el("ready").hidden = next.phase !== "waiting" || me.ready;
  const opponent = next.players.find((p) => !p.you);
  el("rematch").hidden = next.phase !== "finished" || !opponent;
  el("rematch").disabled = !!me.rematch;
  el("answer").hidden = !next.solved;
  let headline;
  if (next.phase === "waiting") {
    headline =
      next.players.length === 1
        ? "Share the room code with your friend."
        : "Both players must be ready to start.";
  } else if (next.phase === "finished") {
    headline = (next.won ? "You won" : "You lost") + " · " + next.reason + ".";
    if (!opponent) headline += " Your opponent has left the room.";
    else if (me.rematch)
      headline += " Waiting for " + opponent.name + " to play again.";
    else if (opponent.rematch)
      headline += " " + opponent.name + " wants to play again.";
  } else if (next.countdown > 0) {
    headline = "Starting in " + Math.ceil(next.countdown) + "…";
  } else {
    headline = "Race in progress";
    if (
      next.round !== previous?.round ||
      next.index !== previous?.index ||
      next.prefix !== previous?.prefix
    )
      drawBoard(next);
    el("budget").textContent = next.hints_left + " of 3 hints left";
    for (const kind of ["letter", "word"]) {
      const wait = Math.ceil(next[kind + "_wait"]);
      const label = kind === "letter" ? "Reveal a letter" : "Reveal word";
      el(kind).disabled = !next.hints_left || wait > 0;
      el(kind).textContent =
        label + (wait && next.hints_left ? " (" + wait + "s)" : "");
    }
  }
  if (el("headline").textContent !== headline)
    el("headline").textContent = headline;
}

function drawBoard(game) {
  const rows = el("rows");
  rows.replaceChildren();
  for (let i = 0; i <= game.total; i++) {
    const row = document.createElement("li");
    rows.append(row);
    if (i > game.index) {
      row.className = "conceal";
      row.setAttribute("aria-label", "Hidden word");
      continue;
    }
    const active = i === game.index;
    row.className = "row " + (active ? "active" : i ? "solved" : "given");
    const letters = active ? game.prefix.padEnd(game.length) : game.solved[i];
    for (const [j, letter] of Array.from(letters).entries()) {
      if (letter !== " ") {
        const tile = document.createElement("span");
        tile.className = "slot" + (active ? " fixed" : "");
        tile.textContent = letter;
        row.append(tile);
        continue;
      }
      const input = document.createElement("input");
      input.className = "slot";
      input.maxLength = 1;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute(
        "aria-label",
        "Letter " + (j + 1) + " of " + game.length,
      );
      input.onfocus = () => input.select();
      input.oninput = () => {
        input.value = input.value.toUpperCase().replace(/[^A-Z]/g, "");
        if (!input.value) return;
        const boxes = Array.from(row.querySelectorAll("input"));
        const empty = boxes.find((box) => !box.value);
        if (empty) (input.nextElementSibling || empty).focus();
        else {
          request("guess", {
            guess: game.prefix + boxes.map((box) => box.value).join(""),
            index: game.index,
            round: game.round,
          });
        }
      };
      input.onpaste = (event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text").trim().toUpperCase();
        const boxes = Array.from(row.querySelectorAll("input"));
        const whole =
          text.length === game.length && text.startsWith(game.prefix);
        const pasted = whole ? text.slice(game.prefix.length) : text;
        const start = whole ? 0 : boxes.indexOf(input);
        if (!/^[A-Z]+$/.test(pasted) || pasted.length > boxes.length - start)
          return;
        Array.from(pasted).forEach((letter, n) => {
          boxes[start + n].value = letter;
        });
        boxes[start + pasted.length - 1].dispatchEvent(new Event("input"));
      };
      input.onkeydown = (event) => {
        if (
          event.key === "Backspace" &&
          !input.value &&
          input.previousElementSibling?.matches("input")
        ) {
          event.preventDefault();
          input.previousElementSibling.value = "";
          input.previousElementSibling.focus();
        }
      };
      row.append(input);
    }
  }
  rows.querySelector("input")?.focus();
}

function request(action, values = {}) {
  if (action === "sync" && pending) return;
  pending++;
  queue = queue
    .then(async () => {
      const create = action === "create";
      if (!create && !code && action !== "join") return;
      if ((create || action === "join") && state) return;
      const target = action === "join" ? values.code : code;
      const response = await fetch(
        "/api/rooms" + (create ? "" : "/" + encodeURIComponent(target)),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Room-Token": token,
          },
          body: JSON.stringify(
            create ? { name: values.name } : { action, ...values },
          ),
          signal: AbortSignal.timeout(10000),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) reset();
        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : "Check your room details.",
        );
      }
      if (data.left) reset();
      else render(data);
      if (data.correct === false) {
        const boxes = el("rows").querySelectorAll("input");
        for (const box of boxes) box.value = "";
        boxes[0]?.focus();
      }
      if (
        action !== "sync" ||
        el("notice").dataset.error === "yes" ||
        data.phase === "finished"
      ) {
        el("notice").textContent =
          data.correct === false ? "Try another word." : "";
        el("notice").dataset.error = "";
      }
    })
    .catch((err) => {
      el("notice").textContent = err.message;
      el("notice").dataset.error = "yes";
    })
    .finally(() => {
      pending--;
    });
}

el("setup").onsubmit = (event) => {
  event.preventDefault();
  const name = el("name").value.trim();
  const roomCode = el("code").value.trim().toUpperCase();
  const join = event.submitter?.value === "join";
  if (!name || (join && !/^[A-Z2-9]{6}$/.test(roomCode))) {
    el("notice").textContent = !name
      ? "Enter your name."
      : "Enter the six-character room code.";
    return;
  }
  localStorage.setItem("wl-name", name);
  request(join ? "join" : "create", { name, code: roomCode });
};
el("ready").onclick = () => request("ready");
el("rematch").onclick = () => request("rematch", { round: state.round });
el("leave").onclick = () => request("leave");
for (const kind of ["letter", "word"]) {
  el(kind).onclick = () =>
    request("hint", {
      kind,
      used: state.used,
      index: state.index,
      round: state.round,
    });
}
if (code) request("sync");
setInterval(() => {
  if (code) request("sync");
}, 1500);
