/**
 * EVERY LIST ON EVERY PAGE, AT EVERY WIDTH, IN A REAL BROWSER (issue 1049; `listTable` in src/web/shared.js, "Lists" in
 * src/web/app.css). Each page is loaded over the server's own state, with long names and long messages in every list
 * (tests/web-lists-fixtures.ts), at every width from 320 to 1600 px, every 10 px, in light and dark. For every list it
 * holds:
 *
 * - ONE WAY TO WRITE A LIST: every table of rows is a `listTable`, a table in its `.list` card. Only a table of facts
 *   (a label and its value) and a chart's legend are not lists.
 * - THE LIST NEVER OVERFLOWS ITS CARD: the card stays inside the page's column, and what is wider scrolls inside it.
 * - NO COLUMN IS SQUEEZED BELOW ITS CONTENT: no line of a cell runs past its cell's edges. A name or value the
 *   stylesheet cuts carries its whole as its title, and a Tables name or state is never cut (the rules file's
 *   "bounded", and issue 884).
 * - ONLY THE CARD SCROLLS, NEVER THE PAGE, and where a list scrolls, each row's actions stay pinned at the card's right.
 *
 * A browser is needed: this runs where Playwright and its Chromium are installed (`require("playwright")`). CI installs
 * them (.github/workflows/ci.yml, unit), and there the test refuses to skip.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PAGES, NOW, serveThePage } from "./web-lists-fixtures.ts";

type Page = { clock: { setFixedTime(time: number): Promise<void> }; goto(url: string): Promise<unknown>; waitForSelector(s: string): Promise<unknown>; evaluate<T = unknown>(expression: string): Promise<T>;
  setViewportSize(s: { width: number; height: number }): Promise<void>; close(): Promise<void> };
type Browser = { newPage(o: { viewport: { width: number; height: number }; colorScheme?: "light" | "dark" }): Promise<Page>; close(): Promise<void> };
const playwright = ((): { chromium: { launch(): Promise<Browser> } } | null => {
  try { return createRequire(import.meta.url)("playwright"); } catch { return null; }
})();
// in CI a layout test that skips guards nothing: there it fails instead (GitHub Actions sets CI=true)
const noBrowser = playwright === null && process.env.CI !== "true" ? "Playwright is not installed here (require('playwright')): the page needs a browser to be measured" : false;

const served = noBrowser ? null : serveThePage();
let browser: Browser | null = null;
after(async () => {
  await browser?.close();
  await (await served)?.close();
});

/** 320 to 1600 px, every 10 px. */
const WIDTHS = Array.from({ length: 129 }, (_, i) => 320 + 10 * i);

/** What is wrong with the lists of the page shown, a line each; none when nothing is. */
const MEASURE = `(() => {
  const out = [];
  const section = document.querySelector('section[id^="page-"]:not([hidden])');
  const seen = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  if (document.documentElement.scrollWidth > window.innerWidth) out.push("the page scrolls sideways (" + (document.documentElement.scrollWidth - window.innerWidth) + " px)");
  let lists = 0;
  for (const table of section.querySelectorAll("table")) {
    if (table.matches(".u-legend, .facts-table") || !seen(table)) continue;
    const name = "table." + (table.className || "(no class)");
    const card = table.parentElement;
    if (!card.matches(".list")) { out.push(name + " is not in a list's card (listTable)"); continue; }
    lists++;
    // the card inside its column: the box it is laid out in, whatever that is
    const col = card.parentElement.getBoundingClientRect(), box = card.getBoundingClientRect();
    if (box.right > Math.min(col.right, window.innerWidth) + 0.5 || box.left < Math.max(col.left, 0) - 0.5) out.push(name + "'s card runs past its column (" + box.left.toFixed(1) + " to " + box.right.toFixed(1) + " in " + col.left.toFixed(1) + " to " + col.right.toFixed(1) + ")");
    const scrolls = card.scrollWidth > card.clientWidth + 1;
    if (scrolls && !["auto", "scroll"].includes(getComputedStyle(card).overflowX)) out.push(name + " is wider than its card, which cannot scroll");
    // where the list scrolls, a row's actions are pinned at the card's right (the card scrolled to its start)
    if (scrolls) {
      const left = card.scrollLeft;
      card.scrollLeft = 0;
      const inner = card.getBoundingClientRect().left + card.clientLeft + card.clientWidth;
      for (const act of table.querySelectorAll("td.act")) {
        if (!seen(act)) continue;
        if (getComputedStyle(act).position !== "sticky" || Math.abs(act.getBoundingClientRect().right - inner) > 1) {
          out.push(name + ": a row's actions are not pinned at its card's right (" + act.getBoundingClientRect().right.toFixed(1) + ", the card's right " + inner.toFixed(1) + ")");
          break;
        }
      }
      // and the pinned actions cover no other control of a row: each control whose centre is in the card's view, the
      // card at its start, is what a tap at its centre reaches (issue 1049's review: on a phone, Users' From… went under
      // the pinned buttons). The page is scrolled to bring each to the window's middle, and back.
      const viewLeft = card.getBoundingClientRect().left + card.clientLeft, y0 = window.scrollY;
      for (const c of table.querySelectorAll("tbody :is(button, a[href], summary, input, select)")) {
        if (!seen(c) || c.closest("td.act, .pop")) continue;
        let r = c.getBoundingClientRect();
        const x = (r.left + r.right) / 2;
        if (x < viewLeft || x > inner) continue;
        window.scrollBy(0, (r.top + r.bottom) / 2 - window.innerHeight / 2);
        r = c.getBoundingClientRect();
        const hit = document.elementFromPoint(x, (r.top + r.bottom) / 2);
        if (hit === null || !(hit === c || c.contains(hit))) {
          out.push(name + ": " + JSON.stringify(c.textContent.trim().slice(0, 30)) + " is under " + (hit?.closest("td.act") ? "the pinned actions" : (hit?.tagName ?? "nothing")) + " at its centre");
        }
      }
      window.scrollTo(window.scrollX, y0);
      card.scrollLeft = left;
    }
    const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    for (const tr of table.querySelectorAll("tr")) {
      if (!seen(tr)) continue;
      [...tr.children].forEach((cell, i) => {
        if (!seen(cell)) return;
        const where = name + " " + (heads[i] || "column " + (i + 1)) + " of " + JSON.stringify(tr.textContent.trim().replace(/\\s+/g, " ").slice(0, 40));
        const cellBox = cell.getBoundingClientRect();
        // each text's lines, or, inside an element that cuts what overflows it, that element (and it must say its whole)
        const rects = [];
        const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let t = walk.nextNode(); t; t = walk.nextNode()) {
          if (!t.textContent.trim() || !seen(t.parentElement)) continue;
          // a popover's words are its own box's, not the cell's
          if (t.parentElement.closest(".pop, details:not([open]) > :not(summary)")) continue;
          // every element from the text up to its cell, the cell included, whose overflow is not visible: the text's box is
          // the outermost one's. Of them, each that CUTS (hidden or clip: a box that scrolls is read by scrolling it) and
          // does cut this text must let it be read whole by a title, on the text's element or on one around it
          const boxes = [];
          for (let e = t.parentElement; e && e !== tr; e = e.parentElement) if (getComputedStyle(e).overflowX !== "visible") boxes.push(e);
          // the text's own lines, from a range: scrollWidth is whole pixels, and missed a cut under one (issue 1049); 0.05 px
          // is past the layout's rounding (1/64 px), and under the 0.6 px cut it missed
          // Text that wraps is measured word by word: a line that fills its box ends in a space, which hangs past the edge
          const wraps = !["nowrap", "pre"].includes(getComputedStyle(t.parentElement).whiteSpace);
          const lines = [];
          for (const m of wraps ? t.textContent.matchAll(/\\S+/g) : [{ index: 0, 0: t.textContent }]) {
            const own = document.createRange();
            own.setStart(t, m.index);
            own.setEnd(t, m.index + m[0].length);
            lines.push(...[...own.getClientRects()].filter((r) => r.width > 0));
          }
          const titled = t.parentElement.closest("[title]") !== null;
          for (const clip of boxes) {
            const cs = getComputedStyle(clip);
            if (!["hidden", "clip"].includes(cs.overflowX)) continue;
            const b = clip.getBoundingClientRect();
            const inLeft = b.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), inRight = b.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
            const over = Math.max(0, ...lines.map((r) => Math.max(r.right - inRight, inLeft - r.left)));
            const past = over > 0.05;
            // down too: a box that clamps its lines (a statement's two)
            const below = clip.scrollHeight > clip.clientHeight + 0.5 && lines.some((r) => r.bottom > b.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom) + 0.05);
            if (!past && !below) continue;
            if (table.matches(".catalog") && clip.closest("code.name, td.state")) out.push(where + ": a table's name or state is cut");
            // Sync events holds a usual name whole above the phone layout: one of 30 characters or fewer (issue 1049)
            else if (table.matches(".events") && window.innerWidth > 640 && clip.matches("code.name") && t.textContent.length <= 30) out.push(where + ": the name " + JSON.stringify(t.textContent) + " is cut");
            else if (!t.parentElement.closest("code.stmt") && !titled) out.push(where + ": " + JSON.stringify(t.textContent.trim().slice(0, 30)) + " is cut by " + over.toFixed(2) + " px, with no title to read it whole");
          }
          if (boxes.length) { rects.push(boxes[boxes.length - 1].getBoundingClientRect()); continue; }
          const range = document.createRange();
          range.selectNodeContents(t);
          rects.push(...range.getClientRects());
        }
        for (const r of rects) {
          if (r.width === 0) continue;
          const past = Math.max(cellBox.left - r.left, r.right - cellBox.right);
          if (past > 0.5) { out.push(where + " runs " + past.toFixed(1) + " px past its cell"); break; }
        }
      });
    }
  }
  if (lists === 0) out.push("no list was measured");
  return [...new Set(out)];
})()`;

/**
 * Resolves once the page has been laid out at `width` and its resize observers have run (issue 1150). A chart takes
 * its holder's width in a ResizeObserver (src/web/charts.js). The browser runs those in a rendering step, after the
 * step's layout. Measured before that step, a chart still has the width before. At the widths where the charts' grid
 * goes from one column to two (970 and 1140 px), a chart in the right column then stood out of the page by 387 px.
 *
 * Two animation frames were not that step. Under load, Chromium ran both callbacks at the new `innerWidth` before the
 * step that sent the resize event and ran the observers. So this waits on an observer of its own. A new observer
 * reports in the next step that runs the observers. When it reports at `width`, a second new observer waits for the
 * step after, so every observer of that step, the page's included, has run. It gives up after 10 s.
 */
const atWidth = (width: number) => `new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("the page was never laid out at ${width} px (it is " + window.innerWidth + " px wide)")), 10000);
  const nextStep = (then) => { const o = new ResizeObserver(() => { o.disconnect(); then(); }); o.observe(document.documentElement); };
  const step = () => nextStep(() => window.innerWidth === ${width} ? nextStep(() => { clearTimeout(timer); resolve(null); }) : step());
  step();
})`;

async function open(hash: string, ready: string, width: number, colorScheme: "light" | "dark"): Promise<Page> {
  browser ??= await playwright!.chromium.launch();
  const p = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
  // the page's now is the fixtures' (`NOW`), whatever day the test runs: Date.now and new Date() read it, and the timers
  // still run
  await p.clock.setFixedTime(NOW);
  await p.goto(`http://127.0.0.1:${(await served)!.port}/${hash}`);
  await p.waitForSelector(ready);
  await p.evaluate("document.fonts.ready.then(() => null)");
  // every list a closed <details> holds is measured too (Usage's memory, a request's own row): each opened as a person
  // opens it, then the reads it starts answered
  await p.evaluate(`(() => { for (const s of document.querySelectorAll('section[id^="page-"]:not([hidden]) details:not([open]) > summary')) s.click(); })()`);
  await p.evaluate("new Promise((r) => setTimeout(r, 500))");
  return p;
}

for (const page of PAGES) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${page.id}: every list stays in its card, squeezes no column below its content, and scrolls in its card, never the page, from 320 to 1600 px (${scheme})`, { skip: noBrowser }, async () => {
      assert.ok(playwright !== null, "CI runs this test: Playwright and its Chromium are installed there (.github/workflows/ci.yml)");
      const p = await open(page.hash, page.ready, WIDTHS[0]!, scheme);
      const shown = await p.evaluate<string>(`document.querySelector('section[id^="page-"]:not([hidden])').innerText`);
      for (const s of page.says ?? []) assert.ok(shown.includes(s), `${page.id} says ${JSON.stringify(s)} at the fixtures' clock, so its lists are measured with it`);
      const found: string[] = [];
      for (const width of WIDTHS) {
        await p.setViewportSize({ width, height: 900 });
        await p.evaluate(atWidth(width));
        for (const s of await p.evaluate<string[]>(MEASURE)) found.push(`${width} px: ${s}`);
      }
      await p.close();
      assert.deepEqual(found, [], `what is wrong with ${page.id}'s lists:\n${found.join("\n")}`);
    });
  }
}
