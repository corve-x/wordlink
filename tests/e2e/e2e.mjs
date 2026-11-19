// End-to-end check: real server + real static files, UI driven through the DOM in jsdom.
// usage: node e2e.mjs   (expects the server from serve_fake_clock.py on PORT, see run_e2e.sh)
import { JSDOM } from "jsdom";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = process.env.PORT || 8123,
  BASE = `http://127.0.0.1:${PORT}/`;
const DB = process.env.DB,
  OFFSET = process.env.OFFSET_FILE;
const PID = "e2e-player-aaaa",
  PID2 = "e2e-player-bbbb";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  " + extra}`);
  if (!ok) fails++;
};
const oracle = (pid, mode, field) =>
  JSON.parse(execFileSync("python3", ["oracle.py", DB, pid, mode, field]));

async function open(pid) {
  const dom = await JSDOM.fromURL(BASE, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, BASE), o);
      w.matchMedia = () => ({ matches: true, addEventListener() {} });
      w.localStorage.setItem("wl-player", pid);
      w.HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      w.HTMLDialogElement.prototype.close = function () {
        this.open = false;
      };
    },
  });
  const w = dom.window,
    d = w.document;
  const ui = {
    w,
    d,
    entry: d.querySelector("#entry"),
    timer: () => d.querySelector("#timer").textContent,
    msg: () => d.querySelector("#msg").textContent,
    rows: () =>
      [...d.querySelectorAll("#rows > li")].map((li) => ({
        kind: li.classList.contains("active")
          ? "active"
          : li.classList.contains("hidden")
            ? "hidden"
            : li.classList.contains("given")
              ? "given"
              : "solved",
        text: [...li.querySelectorAll(".slot")]
          .map((s) => s.textContent || "_")
          .join(""),
      })),
    until: async (fn, ms = 4000) => {
      const t = Date.now();
      while (Date.now() - t < ms) {
        if (fn()) return true;
        await sleep(40);
      }
      return false;
    },
    type(ch) {
      const e = ui.entry;
      e.focus();
      const all =
        e.selectionStart === 0 &&
        e.selectionEnd === e.value.length &&
        e.value.length > 0;
      e.value = all ? ch : e.value + ch;
      e.dispatchEvent(new w.Event("input", { bubbles: true }));
    },
    paste(text) {
      ui.entry.focus();
      const ev = new w.Event("paste", { bubbles: true, cancelable: true });
      ev.clipboardData = { getData: () => text };
      ui.entry.dispatchEvent(ev);
    },
    click: (sel) => d.querySelector(sel).click(),
    activeIndex: () => ui.rows().findIndex((r) => r.kind === "active"),
  };
  await ui.until(() =>
    ui.rows().some((r) => r.kind === "active" || r.kind === "solved"),
  );
  return ui;
}
async function typeWord(ui, word, fixedLen) {
  for (const ch of word.slice(fixedLen)) ui.type(ch);
}

// ---------- 1. fresh load ----------
let ui = await open(PID);
let words = oracle(PID, "daily", "words");
let rows = ui.rows();
check(
  rows[0].kind === "given" && rows[0].text === words[0],
  "daily loads with the first word filled in",
);
check(
  rows[1].kind === "active" &&
    rows[1].text[0] === words[1][0] &&
    rows[1].text.length === words[1].length,
  "current row shows first letter and length",
  rows[1].text,
);
check(
  rows.slice(2).every((r) => r.kind === "hidden"),
  "future words are concealed",
);
check(ui.timer() === "00:00", "timer reads 00:00 on open");
check(
  ["#hint-letter", "#hint-word"].every((s) => ui.d.querySelector(s).disabled),
  "hints are locked before the timer starts",
);
check(
  !ui.d.querySelector("#hint-letter").textContent.includes("NaN") &&
    /15s/.test(ui.d.querySelector("#hint-letter").textContent) &&
    /60s/.test(ui.d.querySelector("#hint-word").textContent),
  "locked hints show remaining seconds",
);
check(
  !ui.d.querySelector("input[type=submit],button[type=submit]") &&
    ui.d.querySelectorAll("input").length === 1,
  "one text input, no submit/start button",
);

// ---------- 2. focus / About leave the timer at zero ----------
ui.entry.focus();
ui.entry.dispatchEvent(new ui.w.Event("focus"));
ui.click("#open-about");
await sleep(1500);
const about = ui.d.querySelector("#about");
check(
  about.open &&
    about.textContent.includes("BLACK") &&
    about.textContent.includes("CREAM"),
  "About opens and explains BLACK → ICE → CREAM",
);
const credit = [...about.querySelectorAll("p")].map((p) =>
  p.textContent.trim(),
);
const link = about.querySelector("a");
check(
  about.querySelector("hr") &&
    credit.includes("Built by Satya") &&
    link.href === "https://github.com/corve-x",
  'About ends with divider, "Built by Satya" and the GitHub link',
);
ui.click("#about [data-close]");
check(
  ui.timer() === "00:00" && oracle(PID, "daily", "started") === false,
  "viewing, focusing and About keep the timer at zero (backend not started)",
);

// ---------- 3. wrong guess, then the right one ----------
const L = words[1].length;
const wrong = "Q".repeat(L - 1);
ui.type("Q");
await ui.until(() => oracle(PID, "daily", "started"), 3000);
check(
  oracle(PID, "daily", "started") === true,
  "first typed letter starts the backend timer (even though it is wrong)",
);
for (const ch of wrong.slice(1)) ui.type(ch);
await ui.until(() => /Not quite/.test(ui.msg()));
check(
  /Not quite/.test(ui.msg()) && ui.rows()[1].kind === "active",
  "wrong full guess shows brief feedback and stays on the row",
);
check(
  ui.entry.selectionStart === 0 &&
    ui.entry.selectionEnd === ui.entry.value.length &&
    ui.entry.value.length === L - 1,
  "editable part is selected for the next attempt",
);
check(ui.rows()[1].text[0] === words[1][0], "given first letter stays fixed");
const ans = words[1].slice(1);
ui.type(ans[0]); // replaces the selection
check(
  ui.entry.value === ans[0],
  "next keystroke replaces the selected attempt",
);
for (const ch of ans.slice(1)) ui.type(ch);
await ui.until(() => ui.rows()[1].kind === "solved");
check(
  ui.rows()[1].kind === "solved" &&
    ui.rows()[1].text === words[1] &&
    ui.activeIndex() === 2,
  "correct word locks in and the next row becomes active",
);
check(
  ui.d.activeElement === ui.entry,
  "focus stays in the entry for the next word",
);

// ---------- 4. paste: whole answer, then missing letters only ----------
ui.paste(words[2].toLowerCase());
await ui.until(() => ui.activeIndex() === 3);
check(
  ui.rows()[2].text === words[2],
  "pasting the whole answer solves the row",
);
ui.paste(words[3].slice(1));
await ui.until(() => ui.activeIndex() === 4);
check(
  ui.rows()[3].text === words[3],
  "pasting only the missing letters solves the row",
);

// ---------- 5. refresh ----------
const t0 = ui.timer();
await sleep(1200);
ui.w.close();
ui = await open(PID);
rows = ui.rows();
check(
  rows.slice(0, 4).every((r, i) => r.text === words[i]) &&
    ui.activeIndex() === 4,
  "refresh restores solved rows and the active row",
);
check(
  ui.timer() !== "00:00" && ui.timer() >= t0,
  "refresh keeps the running timer",
  `${t0} -> ${ui.timer()}`,
);

// ---------- 6. mode switching ----------
ui.click("[data-mode=free]");
await ui.until(
  () =>
    ui.d.querySelector("[data-mode=free]").getAttribute("aria-pressed") ===
      "true" &&
    ui.rows()[0].kind === "given" &&
    ui.timer() === "00:00",
);
const fwords = oracle(PID, "free", "words");
check(
  ui.rows()[0].text === fwords[0] &&
    ui.timer() === "00:00" &&
    ui.activeIndex() === 1,
  "Free play loads a separate chain immediately",
);
ui.type("Q"); // starts the free-play timer
const freeStart = Date.now();
ui.click("[data-mode=daily]");
await ui.until(() => ui.rows()[0].text === words[0] && ui.activeIndex() === 4);
check(
  ui.rows()[3].text === words[3] && ui.timer() !== "00:00",
  "switching back to Daily restores that board and timer",
);
await sleep(1100);
ui.click("[data-mode=free]");
await ui.until(() => ui.rows()[0].text === fwords[0]);
check(
  ui.activeIndex() === 1 && ui.timer() !== "00:00" && ui.entry.value === "Q",
  "switching to Free play restores its board, timer and typed letters",
  `active=${ui.activeIndex()} timer=${ui.timer()} entry=${JSON.stringify(ui.entry.value)} started=${oracle(PID, "free", "started")}`,
);

// ---------- 7. hints (real time: 15s letter, 60s word) ----------
const letterBtn = ui.d.querySelector("#hint-letter"),
  wordBtn = ui.d.querySelector("#hint-word");
check(
  letterBtn.disabled && wordBtn.disabled,
  "both hints locked right after the first letter",
);
await sleep(Math.max(0, freeStart + 16200 - Date.now()));
check(
  !letterBtn.disabled &&
    wordBtn.disabled &&
    /60|59|4\d|5\d/.test(wordBtn.textContent),
  "after ~16s: letter hint unlocks, word hint still locked",
  letterBtn.textContent + " | " + wordBtn.textContent,
);
const before = ui.rows()[1].text;
letterBtn.click();
await ui.until(() => ui.rows()[1].text[1] === fwords[1][1]);
check(
  ui.rows()[1].text.slice(0, 2) === fwords[1].slice(0, 2),
  "Reveal a letter fills the next missing letter",
  `${before} -> ${ui.rows()[1].text}`,
);
check(
  letterBtn.disabled && /1[0-5]s/.test(letterBtn.textContent),
  "second letter hint needs another 15s",
  letterBtn.textContent,
);
check(
  wordBtn.disabled && /4\ds/.test(wordBtn.textContent),
  "letter hint did not restart the 60s word countdown",
  wordBtn.textContent,
);
await sleep(Math.max(0, freeStart + 61200 - Date.now()));
check(!wordBtn.disabled, "word hint unlocks at 60s");
wordBtn.click();
await ui.until(() => ui.activeIndex() === 2);
check(
  ui.rows()[1].text === fwords[1] && ui.activeIndex() === 2,
  "Reveal word fills the row and advances",
);
check(
  letterBtn.disabled &&
    wordBtn.disabled &&
    /15s/.test(letterBtn.textContent) &&
    /60s/.test(wordBtn.textContent),
  "new row restarts both countdowns",
);

// ---------- 8. finish the free round ----------
for (let i = 2; i < 6; i++) {
  await typeWord(ui, fwords[i], 1);
  await ui.until(() => ui.activeIndex() !== i);
}
await ui.until(() => !ui.d.querySelector("#after").hidden);
check(
  ui.rows().every((r, i) => r.text === fwords[i]) &&
    ui.d.querySelector("#hints").hidden,
  "free round completes; board stays visible, hints hidden",
);
const frozen = ui.timer();
await sleep(1300);
check(
  ui.timer() === frozen &&
    /Solved in/.test(ui.d.querySelector("#summary").textContent) &&
    !ui.d.querySelector("#new-chain").hidden,
  'timer stops; summary and "New chain" appear',
  frozen + " / " + ui.timer(),
);
ui.click("#open-history");
await ui.until(() => ui.d.querySelectorAll("#hist-list li .seq").length === 1);
let items = [...ui.d.querySelectorAll("#hist-list li")];
check(
  items.length === 1 &&
    items[0]
      .querySelector(".seq")
      .textContent.replace(/→/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .join(",") === fwords.join(",") &&
    /Free play/.test(items[0].textContent) &&
    /2 hints/.test(items[0].textContent),
  "history shows full sequence, mode, time, elapsed and hints used",
  items[0]?.textContent,
);
ui.click("#history [data-close]");
ui.click("#new-chain");
await ui.until(() => ui.d.querySelector("#after").hidden);
const f2 = oracle(PID, "free", "words");
check(
  f2.join() !== fwords.join() &&
    ui.rows()[0].text === f2[0] &&
    ui.timer() === "00:00",
  '"New chain" loads a different chain with a fresh timer',
);

// ---------- 9. finish the daily, check history order ----------
ui.click("[data-mode=daily]");
await ui.until(() => ui.activeIndex() === 4);
for (let i = 4; i < 6; i++) {
  await typeWord(ui, words[i], 1);
  await ui.until(() => ui.activeIndex() !== i);
}
await ui.until(() => !ui.d.querySelector("#after").hidden);
check(
  /midnight/.test(ui.d.querySelector("#summary").textContent) &&
    ui.rows().every((r, i) => r.text === words[i]),
  "daily completes and shows the finished board",
);
ui.w.close();
ui = await open(PID);
await ui.until(() => !ui.d.querySelector("#after").hidden);
check(
  ui.rows().every((r, i) => r.text === words[i]) &&
    ui.d.querySelector("#hints").hidden,
  "refreshing a finished daily shows the completed board (no replay)",
);
ui.click("#open-history");
await ui.until(() => ui.d.querySelectorAll("#hist-list li .seq").length >= 2);
items = [...ui.d.querySelectorAll("#hist-list li")];
check(
  items.length === 2 &&
    /Daily/.test(items[0].textContent) &&
    /Free play/.test(items[1].textContent) &&
    oracle(PID, "daily", "count") === 2,
  "two entries, newest first, no duplicate from the refresh",
);

// ---------- 10. history cap of 10, daily stays finished ----------
const api = async (path, pid, body, method) =>
  (
    await fetch(BASE + "api" + path, {
      method: method || (body ? "POST" : "GET"),
      headers: { "X-Player-Id": pid, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })
  ).json();
for (let n = 0; n < 11; n++) {
  const resp = await api("/free/new", PID, undefined, "POST");
  if (!resp.game) console.log("free/new response", JSON.stringify(resp));
  const g = resp.game;
  const w = oracle(PID, "free", "words");
  for (const word of w.slice(1))
    await api(`/games/${g.id}/guess`, PID, { guess: word });
}
ui.w.close();
ui = await open(PID);
await ui.until(() => !ui.d.querySelector("#after").hidden);
check(
  ui.rows().every((r, i) => r.text === words[i]) &&
    ui.d.querySelector("#hints").hidden,
  "after 11 more practice rounds today's daily is still finished",
);
ui.click("#open-history");
await ui.until(() => ui.d.querySelectorAll("#hist-list li .seq").length === 10);
items = [...ui.d.querySelectorAll("#hist-list li")];
check(
  items.length === 10 &&
    oracle(PID, "daily", "count") === 10 &&
    items.every((li) => /Free play/.test(li.textContent)),
  "history keeps only the latest 10 (oldest, including the daily, pruned)",
);

// ---------- 11. IST midnight boundary in the UI ----------
const target = (d, h, m, s) =>
  (Date.UTC(2026, 10, d, h, m, s) - 5.5 * 3600e3) / 1000 - Date.now() / 1000;
writeFileSync(OFFSET, String(target(19, 23, 59, 58)));
ui.w.close();
ui = await open(PID2);
const day1 = oracle(PID2, "daily", "day"),
  w19 = oracle(PID2, "daily", "words");
check(
  day1 === "2026-11-19" && ui.rows()[0].text === w19[0],
  "at 23:59:58 IST the daily is the 19th puzzle",
  day1,
);
writeFileSync(OFFSET, String(target(20, 0, 0, 2)));
ui.d.dispatchEvent(new ui.w.Event("visibilitychange"));
await ui.until(() => oracle(PID2, "daily", "day") === "2026-11-20");
await ui.until(() => ui.rows()[0].text === oracle(PID2, "daily", "words")[0]);
const w20 = oracle(PID2, "daily", "words");
check(
  oracle(PID2, "daily", "day") === "2026-11-20" &&
    w20.join() !== w19.join() &&
    ui.rows()[0].text === w20[0] &&
    ui.timer() === "00:00",
  "after midnight IST the page picks up the new puzzle with a fresh timer",
);
const other = (await api("/state?mode=daily", "e2e-player-cccc")).game;
check(
  other.day === "2026-11-20",
  "every player gets the same date-keyed puzzle",
);

ui.w.close();
console.log(fails ? `\n${fails} check(s) FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
