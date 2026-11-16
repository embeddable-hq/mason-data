/**
 * EVERY ACTION ON THE WEB PAGE SHOWS THAT IT IS WORKING, CAN'T BE SENT TWICE, SHOWS ITS FAILURE IN PLACE, AND LEAVES
 * NOTHING BUSY (issue 1033; src/web/app.js `ctx.send`, src/web/shared.js `sendButton` and `failurePop`).
 *
 * The test FINDS the actions: it runs each page over the server's own fixtures (`runState`), and presses every
 * `button[data-*]` and every `form` the page writes, following the questions and forms a press opens (Remove asks
 * first; a Sync choice asks before a big table's poll). A press that sends a change (any request but a GET) is held
 * unanswered by a fake `fetch`, and the test checks, while it is held, that its control says it is busy (disabled,
 * `aria-busy`) and that a second press sends nothing. Then the change is refused, or the network fails, and the test
 * checks that the page says so in a popover at that control (beside it, or beside the row or question it is in), with a
 * Dismiss that takes it away, and that nothing is left busy. A new button is covered by this test without a new test.
 *
 * Then focused tests: a refused Stop of a cloud tunnel is said, and says the login is still open (issue 1033's gap 1); a
 * double press of a Remove's or a Cancel's question sends one request and says what it did (gap 2); a request that
 * hangs is given up at its deadline, and a body cut off is said (gap 6); a new filter or page keeps the last list
 * greyed while it is read (gap 5).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runState, type RunContext } from "../src/cli/run-server.ts";
import { parseSource, type SourceTable } from "../src/cli/preflight.ts";
import { parseSourceText } from "../src/cli/sources.ts";
import type { CopyState } from "../src/duck/sync.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web");
// imported when the tests run: at a commit without what a test needs, the file still loads and each test fails by name
const web = await import(path.join(WEB, "app.js") as string).catch(() => ({})) as Record<string, unknown>;
type Page = { view(): Record<string, string>; click?(d: Record<string, string>, b: unknown, env: unknown): unknown; submit?(form: unknown, FormData: unknown): unknown;
  dismiss?(): unknown; model?: Record<string, unknown> };
type App = { show(hash: string): void; poll(): Promise<void>; pages: Map<string, Page>; settled(): Promise<unknown> };
const createApp = (fetchFn: unknown, now: () => Date, shown: string): App => {
  assert.equal(typeof web.createApp, "function", "src/web/app.js exports createApp");
  return (web.createApp as (f: unknown, n: () => Date, s: string) => App)(fetchFn, now, shown);
};

// ------------------------------------------------------------------ fixtures: the server's own state over synthetic copies

const at = "2026-11-11T09:00:00.000Z";
const NOW = Date.parse("2026-11-11T09:05:00.000Z");
const col = (name: string, type = "text") => ({ name, type, notNull: false, comment: null });
const table = (name: string, rows: number, key = ["id"]): SourceTable => ({ source: `public.${name}`, schema: "public", table: name, key, rows, bytes: 8192, comment: null,
  columns: [col("id", "bigint"), col("name")], foreignKeys: [] });
const TABLES = [table("customers", 1200), table("orders", 40_000_000), table("audit", 50), table("raw_log", 7, [])];
const parsed = parseSource("postgres://shop:secret@db.example.com:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
const FILE = parseSourceText("kind: postgres\nurl: x\ntables:\n  customers: {}\n  orders: {}\n", "shop", "/app/mason/sources/shop.yml");
assert.ok(!("problems" in FILE));
const kept: CopyState["kept"] = { by: "poll", sync: { mode: "off" }, syncedAt: at, nextAt: null };
const COPIES: CopyState[] = [
  { source: "public.customers", phase: "copied", rows: 1200, bytes: 1, seconds: 1, copiedAt: at, error: null, kept },
  { source: "public.orders", phase: "failed", rows: null, bytes: null, seconds: null, copiedAt: null, error: "could not read the next chunk: connection reset" },
];
const STATE = ((): Record<string, unknown> => {
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: TABLES, systemIdentifier: null }), warnings: [],
    replication: () => ({ slot: "mason_shop", publication: "mason_shop", owned: true }), page: true,
    users: { file: "/app/.mason/users.json", apiKey: "k".repeat(32), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: Date.parse(at),
    sources: () => ({ file: FILE, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext;
  return JSON.parse(JSON.stringify(runState(ctx, COPIES, null, NOW))) as Record<string, unknown>;
})();
/** A temporary cloud tunnel the page opened, as `/api/state` lists it. */
const LISTED = { user: "share_a1b2c3", from: "page", role: null, reads: "every synced table", openedAt: at, via: "pinggy", host: "relay.example", port: 41234, database: "shop", sslmode: "require", endsAt: null, state: "up" };
const sharing = (shares: unknown[]) => ({ ...STATE, share: shares.length ? { port: 40001, fingerprint: "AA", sessions: 0, refusedLogins: 0, droppedConnections: 0, shares } : null, shareEnded: null });
const USERS = { users: [{ name: "metabase", id: "0123456789abcdef", addedAt: at, live: true, from: null },
  { name: "looker", id: "fedcba9876543210", addedAt: at, disabledAt: at, live: true, from: ["192.0.2.0/24"] }], lastUsedNote: null, requestLogDays: 7 };
const RUNNING = { running: [{ session: 4, statement: 9, user: "metabase", applicationName: "Metabase", method: "QUERY", startedAt: at, runningMs: 1500, rows: 0,
  query: "SELECT count(*) FROM orders", queryTruncated: false }] };
const POLLS = ([["poll 5m", 300], ["poll 1h", 3600]] as const).map(([sync, seconds]) => ({ sync, seconds,
  cost: { rows: 40_000_000, scanSeconds: 120, everySeconds: Math.max(seconds, 480), busyPercent: 25, basis: "assumed" } }));
const choiceOf = (name: string, big: boolean) => ({ table: name, sync: { value: "off", from: "default" }, rows: big ? 40_000_000 : 1200, polls: POLLS, bigRows: big,
  live: { allowed: true, checks: [{ name: "wal_level", state: "ok", detail: "logical" }] } });

/** What the run answers each read, by path: the page's reads and what its questions read. A read it has no answer
 *  for is refused, as a run would refuse it, which the page says where that read shows. */
function readAnswer(state: unknown, p: string): Response {
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
  if (p === "api/state") return json(state);
  if (p.startsWith("api/users")) return json(USERS);
  if (p === "api/share/choices") return json({ choices: [], role: null, reads: "every synced table" });
  if (p === "api/running") return json(RUNNING);
  if (p.startsWith("api/usage")) return json({ since: at, until: at, stepSeconds: 60, sampleSeconds: 60, keptDays: 7, samples: [], copySizes: [], unsized: [] });
  if (p.startsWith("api/requests")) return json({ requests: [], keptDays: 7, before: null });
  if (p.startsWith("api/events")) return json({ events: [], keptDays: 7 });
  const columns = /^api\/tables\/([^/]+)\/columns$/.exec(p);
  if (columns) return json({ table: decodeURIComponent(columns[1]!), columns: [col("id", "bigint"), col("name")] });
  const sync = /^api\/tables\/([^/]+)\/sync$/.exec(p);
  if (sync) return json(choiceOf(decodeURIComponent(sync[1]!), decodeURIComponent(sync[1]!) === "public.orders"));
  return new Response(JSON.stringify({ failure: { code: "not_found", message: `no answer for ${p} in this test`, next: [] } }), { status: 404 });
}

// ------------------------------------------------------------------ the page's HTML, read as a tree

interface El { tag: string; attrs: Record<string, string>; children: El[]; parent: El | null; text: string }
const VOID = new Set(["input", "br", "wbr", "img", "hr", "meta", "link", "source", "col", "area", "base", "embed", "param", "track"]);
const decode = (s: string) => s.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** A part's HTML as a tree under an element of the part's id (index.html's element the shell writes it into). */
function parse(html: string, id: string): El {
  const root: El = { tag: "div", attrs: { id }, children: [], parent: null, text: "" };
  let cur = root;
  // a place a long name may break (<wbr>) is no word of its own
  for (const m of html.replace(/<wbr>/g, "").matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g)) {
    if (m[5] !== undefined) { cur.children.push({ tag: "#text", attrs: {}, children: [], parent: cur, text: decode(m[5]) }); continue; }
    if (m[2] === undefined) continue;
    const tag = m[2].toLowerCase();
    if (m[1] === "/") {
      for (let e: El | null = cur; e !== null; e = e.parent) if (e.tag === tag) { cur = e.parent ?? root; break; }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1]!.toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    const el: El = { tag, attrs, children: [], parent: cur, text: "" };
    cur.children.push(el);
    if (m[4] !== "/" && !VOID.has(tag)) cur = el;
  }
  return root;
}
const all = (e: El): El[] => [e, ...e.children.flatMap(all)];
const textOf = (e: El): string => (e.tag === "#text" ? e.text : e.children.map(textOf).join(" ")).replace(/\s+/g, " ").trim();
const classes = (e: El) => (e.attrs.class ?? "").split(/\s+/);
const camel = (k: string) => k.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** An element's dataset, as a browser gives it. */
const dataOf = (e: El): Record<string, string> => Object.fromEntries(Object.entries(e.attrs).filter(([k]) => k.startsWith("data-")).map(([k, v]) => [camel(k.slice(5)), v]));
/** The data that names what a button does (not its rooms, nor the shell's own buttons). */
const LOOKS = new Set(["room", "room2"]);
const SHELLS = new Set(["popX", "copy", "dismissOnce"]);
const actionData = (e: El) => Object.fromEntries(Object.entries(dataOf(e)).filter(([k]) => !LOOKS.has(k)));
const sigOf = (e: El): string => e.tag === "form" ? `form ${e.attrs.id ?? ""} ${JSON.stringify(Object.entries(dataOf(e)).sort())}` : `button ${JSON.stringify(Object.entries(actionData(e)).sort())}`;

/** What a page wrote, as trees: `byId` finds an element in any part, `pops` every popover. */
function forest(parts: Record<string, string>) {
  const roots = Object.entries(parts).map(([id, html]) => parse(html, id));
  const els = roots.flatMap(all);
  const byId = (id: string) => els.find((e) => e.attrs.id === id) ?? null;
  const pops = els.filter((e) => classes(e).includes("pop") && e.attrs["data-anchor"] !== undefined);
  /** The ids a control is at: its own, each element around it, and, in a popover, its anchor and what is around that. */
  const placesOf = (e: El): string[] => {
    const out: string[] = [];
    for (let x: El | null = e; x !== null; x = x.parent) {
      if (x.attrs.id) out.push(x.attrs.id);
      if (classes(x).includes("pop") && x.attrs["data-anchor"]) {
        const a = byId(x.attrs["data-anchor"]);
        out.push(x.attrs["data-anchor"]);
        if (a !== null && a !== x) return [...out, ...placesOf(a)];
      }
    }
    return out;
  };
  return { roots, els, byId, pops, placesOf, find: (sig: string) => els.find((e) => (e.tag === "button" || e.tag === "form") && sigOf(e) === sig) ?? null };
}

/** The controls a person can press: each enabled button whose data says what it does, each form. `within`: only those
 *  inside a question or a form a press opened (a dialog popover). */
function controls(f: ReturnType<typeof forest>, within = false): El[] {
  const inDialog = (e: El) => { for (let x: El | null = e; x !== null; x = x.parent) if (x.attrs.role === "dialog") return true; return false; };
  return f.els.filter((e) => {
    if (within && !inDialog(e)) return false;
    if (e.tag === "form") return true;
    if (e.tag !== "button" || "disabled" in e.attrs) return false;
    const d = actionData(e);
    return Object.keys(d).length > 0 && !Object.keys(d).some((k) => SHELLS.has(k));
  });
}

/** A form as the page reads it: its `elements` (each named control's value, a box's `checked`) and, for FormData, the
 *  values of each name — every box ticked, the radio chosen (`choice`, else the one written checked). */
function formOf(e: El, choice: Record<string, string> = {}) {
  const elements: Record<string, { value: string; checked?: boolean }> = {};
  const ticked: Record<string, string[]> = {};
  for (const x of all(e)) {
    const name = x.attrs.name;
    if (!name) continue;
    if (x.tag === "input") {
      const type = x.attrs.type ?? "text", value = x.attrs.value ?? (type === "checkbox" ? "on" : "");
      if (type === "radio") {
        const on = name in choice ? choice[name] === value : "checked" in x.attrs;
        if (on) { elements[name] = { value }; ticked[name] = [value]; } else elements[name] ??= { value: "" };
      } else if (type === "checkbox") {
        elements[name] = { value, checked: "checked" in x.attrs };
        if ("checked" in x.attrs) (ticked[name] ??= []).push(value);
      } else { elements[name] = { value }; ticked[name] = [value]; }
    } else if (x.tag === "select") {
      const opts = all(x).filter((o) => o.tag === "option");
      const value = (opts.find((o) => "selected" in o.attrs) ?? opts[0])?.attrs.value ?? "";
      elements[name] = { value };
      ticked[name] = [value];
    }
  }
  return { id: e.attrs.id ?? "", dataset: dataOf(e), elements, ticked };
}
class FormData {
  readonly ticked: Record<string, string[]>;
  constructor(form: { ticked: Record<string, string[]> }) { this.ticked = form.ticked; }
  getAll(name: string) { return this.ticked[name] ?? []; }
  get(name: string) { return this.ticked[name]?.[0] ?? null; }
}
/** Each way a form can be sent: as written, and with each choice of each radio group that can be chosen. */
function choicesOf(e: El): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [{}];
  for (const x of all(e)) if (x.tag === "input" && x.attrs.type === "radio" && x.attrs.name && !("disabled" in x.attrs) && !("checked" in x.attrs)) out.push({ [x.attrs.name]: x.attrs.value ?? "" });
  return out;
}

// ------------------------------------------------------------------ a page over a run whose changes are held

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const REFUSAL = { code: "refused", message: "refused by the test", next: [] };

/** A page shown over a fake run: every read answered at once, every change (any method but GET) held until released.
 *  `sent`: the changes asked, in order (a cloud tunnel's beats, which no person sends, left out). */
async function pageOver(id: string, hash: string, state: unknown) {
  const held: Array<{ path: string; answer: (r: Response) => void; fail: (e: Error) => void }> = [];
  const sent: string[] = [];
  const fetchFn = (p: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return Promise.resolve(readAnswer(state, p));
    if (!p.endsWith("/beat")) sent.push(`${method} ${p}`);
    return new Promise<Response>((answer, fail) => { held.push({ path: p, answer, fail }); });
  };
  const app = createApp(fetchFn, () => new Date(NOW), hash);
  app.show(hash);
  await app.poll();
  await app.poll();
  const page = app.pages.get(id)!;
  const env = { doc: { getElementById: () => null }, win: {} };
  return {
    app, page, sent, held,
    parts: () => forest(page.view()),
    press: (e: El, choice: Record<string, string> = {}) => e.tag === "form"
      ? page.submit?.(formOf(e, choice), FormData) ?? null
      : page.click?.(dataOf(e), { dataset: dataOf(e) }, env) ?? null,
    /** release every change held: refused by the run, or the network failed under it */
    release: (how: "refused" | "network") => {
      for (const h of held.splice(0)) {
        if (how === "refused") h.answer(new Response(JSON.stringify({ error: REFUSAL.message, failure: REFUSAL }), { status: 409, headers: { "Content-Type": "application/json" } }));
        else h.fail(new TypeError("Failed to fetch"));
      }
    },
  };
}

/** The pages with actions, each in the states that write them. */
const SCENES: Array<{ name: string; id: string; hash: string; state: unknown }> = [
  { name: "Tables", id: "tables", hash: "#tables", state: STATE },
  { name: "Users", id: "users", hash: "#users", state: sharing([]) },
  { name: "Users with a cloud tunnel open", id: "users", hash: "#users", state: sharing([LISTED]) },
  { name: "Usage", id: "usage", hash: "#observability/usage", state: STATE },
  { name: "Queries", id: "queries", hash: "#observability/queries", state: STATE },
  { name: "Sync events", id: "syncs", hash: "#observability/syncs", state: STATE },
];

type Step = { sig: string; choice: Record<string, string> };
const said = (s: Step) => s.sig.replace(/^button /, "").replace(/^form /, "form ") + (Object.keys(s.choice).length ? ` ${JSON.stringify(s.choice)}` : "");

/** A fresh page with these presses made (each answered: only reads, or a question opened). */
async function replay(scene: (typeof SCENES)[number], steps: Step[]) {
  const p = await pageOver(scene.id, scene.hash, scene.state);
  for (const s of steps) {
    const e = p.parts().find(s.sig);
    assert.ok(e, `${scene.name}: ${said(s)} is written again`);
    await p.press(e, s.choice);
    await settle();
  }
  return p;
}

/** Every path of presses from the page, each ending in a press: a control on the page, or one a press opened. */
async function explore(scene: (typeof SCENES)[number]): Promise<{ actions: Array<{ steps: Step[] }>; pressed: number }> {
  const actions: Array<{ steps: Step[] }> = [];
  const seen = new Set<string>();
  let pressed = 0;
  const walk = async (steps: Step[], depth: number): Promise<void> => {
    const p = await replay(scene, steps);
    const before = p.parts();
    const known = new Set(controls(before).map(sigOf));
    const list = controls(before, steps.length > 0);
    for (const e of list) {
      for (const choice of e.tag === "form" ? choicesOf(e) : [{}]) {
        const step = { sig: sigOf(e), choice };
        const key = JSON.stringify([...steps, step]);
        if (seen.has(key)) continue;
        seen.add(key);
        const q = await replay(scene, steps);
        const n = q.sent.length;
        // never awaited: a change sent is held until released below
        const pressing = Promise.resolve(q.press(q.parts().find(step.sig)!, choice));
        await settle();
        pressed++;
        if (q.sent.length > n) { actions.push({ steps: [...steps, step] }); q.release("refused"); await pressing; await settle(); continue; }
        await pressing;
        // nothing sent: what it opened (a question, a form) is pressed in turn
        const opened = controls(q.parts(), true).filter((x) => !known.has(sigOf(x)));
        if (opened.length > 0 && depth < 3) await walk([...steps, step], depth + 1);
      }
    }
  };
  await walk([], 0);
  return { actions, pressed };
}

/** What a reader is told while a change is sent: its control held and busy. */
const busy = (e: El | null) => e !== null && "disabled" in e.attrs && e.attrs["aria-busy"] === "true";
const submitOf = (e: El | null) => e === null ? null : all(e).find((x) => x.tag === "button" && x.attrs.type === "submit") ?? null;

for (const scene of SCENES) {
  test(`${scene.name}: every action the page writes says it is working, can't be sent twice, says its failure beside it with Dismiss, and leaves nothing busy`, async (t) => {
    const { actions, pressed } = await explore(scene);
    // what was found, for a reader of the run: each action, as the presses that reach it
    t.diagnostic(`${pressed} presses; actions: ${actions.map((a) => a.steps.map(said).join(" → ")).join(" | ") || "none"}`);
    // the pages that change something have controls that send a change; the others' controls (if any) only read
    if (["tables", "users", "usage"].includes(scene.id)) assert.ok(pressed > 0 && actions.length > 0, `${scene.name}: it has actions that send a change`);
    for (const { steps } of actions) {
      for (const how of ["refused", "network"] as const) {
        const last = steps.at(-1)!;
        const what = `${scene.name}: ${steps.map(said).join(" → ")} (${how})`;
        const p = await replay(scene, steps.slice(0, -1));
        const before = p.parts();
        const control = before.find(last.sig)!;
        // where it is: around it, and for a form, the ids in it too (its submit button)
        const places = [...before.placesOf(control), ...(control.tag === "form" ? all(control).map((x) => x.attrs.id).filter((x): x is string => Boolean(x)) : [])];
        const sent = p.sent.length;
        const pressing = Promise.resolve(p.press(control, last.choice));
        await settle();
        assert.equal(p.sent.length, sent + 1, `${what}: one change sent`);
        // while it is sent: its control says so, held
        const now = p.parts();
        const shown = control.tag === "form" ? submitOf(now.find(last.sig)) : now.find(last.sig);
        assert.ok(shown !== null, `${what}: its control stays where it was while it is sent`);
        assert.ok(busy(shown), `${what}: its control is disabled and aria-busy while it is sent (${shown === null ? "gone" : `<${shown.tag} ${JSON.stringify(shown.attrs)}>`})`);
        // a second press sends nothing
        const again = control.tag === "form" ? now.find(last.sig)! : control;
        const second = Promise.resolve(p.press(again, last.choice));
        await settle();
        assert.equal(p.sent.length, sent + 1, `${what}: a second press sends nothing`);
        // refused, or the network failed: said beside it, and nothing left busy
        p.release(how);
        await Promise.all([pressing, second]);
        await settle();
        const after = p.parts();
        assert.deepEqual(after.els.filter(busy).map((e) => textOf(e)), [], `${what}: nothing is left busy`);
        const message = how === "refused" ? REFUSAL.message : "Mason is not answering at this address";
        const failed = after.pops.filter((e) => all(e).some((x) => classes(x).includes("failure")) && textOf(e).includes(message));
        assert.equal(failed.length, 1, `${what}: its failure is said once, in a popover (${failed.length})`);
        const pop = failed[0]!;
        assert.ok(places.includes(pop.attrs["data-anchor"]!), `${what}: its failure is beside it (at ${pop.attrs["data-anchor"]}, the control at ${places.join(", ")})`);
        const close = all(pop).find((x) => x.tag === "button" && "data-pop-close" in x.attrs && !("disabled" in x.attrs));
        assert.ok(close, `${what}: its failure has a Dismiss`);
        // Dismiss takes it away — for an answer, Escape too (the page's `dismiss`)
        if (how === "network" && pop.attrs.role === "status") assert.notEqual(p.page.dismiss?.() ?? null, null, `${what}: Escape dismisses it`);
        else await p.press(close!);
        await settle();
        assert.ok(!p.parts().pops.some((e) => textOf(e).includes(message)), `${what}: dismissed, it is gone`);
      }
    }
  });
}

// ------------------------------------------------------------------ the focused tests

test("a refused Stop of a cloud tunnel is said beside Stop, saying the login is still open, and stays said across polls until dismissed (issue 1033, gap 1)", async () => {
  const p = await pageOver("users", "#users", sharing([LISTED]));
  const stop = p.parts().byId("share-stop");
  assert.ok(stop, "the open login's card has Stop");
  const stopping = Promise.resolve(p.press(stop));
  await settle();
  assert.deepEqual(p.sent, ["DELETE api/share/share_a1b2c3"]);
  assert.ok(busy(p.parts().byId("share-stop")), "Stop says Stopping…, held");
  assert.equal(textOf(p.parts().byId("share-stop")!), "Stopping…");
  p.release("refused");
  await stopping;
  await settle();
  const check = (when: string) => {
    const f = p.parts();
    const pop = f.pops.find((e) => e.attrs["data-anchor"] === "share-stop");
    assert.ok(pop, `${when}: the refusal is said beside Stop`);
    assert.match(textOf(pop), /^Stop failed\. The temporary cloud tunnel is still open, and its address and password still work\. ✗ refused by the test Dismiss$/, when);
    assert.ok(f.byId("share-stop") !== null && !busy(f.byId("share-stop")), `${when}: the card still shows the open login, with Stop to try again`);
    assert.match(textOf(f.byId("added")!), /Online until you stop it/, `${when}: and that it is online`);
  };
  check("refused");
  // the next read of the state still lists it: still said, never turned back into an open login saying nothing
  await p.app.poll();
  check("after a poll");
  assert.equal(p.page.dismiss?.(), true, "Escape dismisses it");
  assert.ok(!p.parts().pops.some((e) => e.attrs["data-anchor"] === "share-stop"), "dismissed");
});

test("a double press of a Remove's or a Cancel's question sends one request, and what it did is said, never a refusal of the second (issue 1033, gap 2)", async () => {
  const removed = { removed: ["public.customers"], already: [] };
  const cases = [
    { scene: SCENES[0]!, open: "button [[\"removeTable\",\"public.customers\"]]", confirm: "button [[\"confirmRemoveTable\",\"public.customers\"]]", body: removed, done: /^Removed public\.customers\./ },
    { scene: SCENES[3]!, open: "button [[\"askCancel\",\"4:9\"]]", confirm: "button [[\"confirmCancel\",\"4:9\"]]", body: { cancelled: { session: 4, statement: 9 } }, done: /^Cancelled session 4's query\./ },
  ];
  for (const c of cases) {
    const p = await pageOver(c.scene.id, c.scene.hash, c.scene.state);
    await p.press(p.parts().find(c.open)!);
    await settle();
    const confirm = p.parts().find(c.confirm)!;
    assert.ok(confirm, `${c.scene.name}: the question asks`);
    const first = Promise.resolve(p.press(confirm));
    await settle();
    const second = Promise.resolve(p.press(p.parts().find(c.confirm)!));
    await settle();
    assert.equal(p.sent.length, 1, `${c.scene.name}: one request, however often its button is pressed`);
    p.held.splice(0).forEach((h) => h.answer(new Response(JSON.stringify(c.body), { status: 200, headers: { "Content-Type": "application/json" } })));
    await Promise.all([first, second]);
    await settle();
    const pops = p.parts().pops.filter((e) => e.attrs.role === "status");
    assert.equal(pops.length, 1, `${c.scene.name}: one answer`);
    assert.match(textOf(pops[0]!), c.done, `${c.scene.name}: what it did, not a refusal: ${textOf(pops[0]!)}`);
  }
});

test("a request that hangs is given up at its deadline, and an answer cut off is said: the page always paints again (issue 1033, gap 6)", async () => {
  const createAsk = web.createAsk as (f: unknown, o?: unknown) => (p: string, i?: unknown) => Promise<{ body?: unknown; failure?: { code: string; message: string } }>;
  assert.equal(typeof createAsk, "function");
  let aborted = false;
  const hung = createAsk((_p: string, init: { signal?: AbortSignal }) => new Promise(() => { init.signal?.addEventListener("abort", () => { aborted = true; }); }), { deadlineMs: 30 });
  const r = await hung("api/remove", { method: "POST" });
  assert.equal(r.failure?.code, "timeout", "given up at its deadline");
  assert.match(r.failure!.message, /did not answer within 0\.03 s/);
  assert.ok(aborted, "and the request aborted");
  const cut = createAsk(async () => ({ ok: true, status: 200, text: async () => { throw new TypeError("network error"); } }));
  const c = await cut("api/sync", { method: "POST" });
  assert.equal(c.failure?.message, "Mason's answer was cut off", "a body cut off is a failure, never a throw");
  // ctx.ask reads; a change goes through ctx.send, which says it is busy and refuses a second send of the same key
  type Ctx = { ask(p: string, i?: unknown): Promise<unknown>; send(k: string, p: string, i?: unknown): Promise<unknown>; sending(k: string): boolean };
  const got: { ctx: Ctx | null } = { ctx: null };
  const probe = { id: "probe", title: "Probe", create(c: Ctx) { got.ctx = c; return { reads: () => [], view: () => ({}) }; } };
  const pages = web.PAGES as unknown[];
  pages.push(probe);
  try {
    let release: (r: Response) => void = () => undefined;
    createApp((_p: string, init?: { method?: string }) => init?.method === "POST" ? new Promise<Response>((r) => { release = r; }) : Promise.resolve(readAnswer(STATE, _p)), () => new Date(NOW), "#overview");
    assert.ok(got.ctx);
    const c2 = got.ctx;
    assert.throws(() => c2.ask("api/remove", { method: "POST" }), /ctx\.ask reads/, "a change is never sent by ctx.ask");
    const first = c2.send("remove:x", "api/remove", { method: "POST" });
    await tick();
    assert.equal(c2.sending("remove:x"), true, "in flight");
    assert.deepEqual(await c2.send("remove:x", "api/remove", { method: "POST" }), { busy: true }, "a second send of the same key sends nothing");
    release(new Response("{\"ok\":true}", { status: 200 }));
    assert.deepEqual(await first, { body: { ok: true } });
    assert.equal(c2.sending("remove:x"), false, "answered: no longer in flight");
  } finally { pages.pop(); }
});

test("a new filter or an older page keeps the last list shown, greyed and busy, until its answer comes — never a blank that moves the page (issue 1033, gap 5)", async () => {
  // Queries: a filter applied, its read held
  let hold: ((r: Response) => void) | null = null;
  const fetchFn = (p: string) => p.includes("outcome=") ? new Promise<Response>((r) => { hold = r; }) : Promise.resolve(p.startsWith("api/requests")
    ? new Response(JSON.stringify({ requests: [], keptDays: 7, before: null }), { status: 200 }) : readAnswer(STATE, p));
  const app = createApp(fetchFn, () => new Date(NOW), "#observability/queries");
  app.show("#observability/queries");
  await app.poll();
  const queries = app.pages.get("queries")!;
  const was = queries.view()["request-log"]!;
  assert.ok(was.length > 0 && !was.includes("Asking Mason"), "the newest page of the log is shown");
  const filtering = (queries as unknown as { submit(f: unknown): Promise<void> }).submit({ id: "request-filters", elements: { status: { value: "refused" }, slow: { checked: false } } });
  await settle();
  const reading = queries.view()["request-log"]!;
  assert.match(reading, /^<div class="reading" aria-busy="true">[\s\S]*<\/div>$/, "the list read last stays, greyed and busy, while the filter is read");
  assert.ok(!reading.includes("Asking Mason"), "never a blank");
  hold!(new Response(JSON.stringify({ requests: [], keptDays: 7, before: null }), { status: 200 }));
  await filtering;
  assert.ok(!queries.view()["request-log"]!.includes("aria-busy"), "answered: the new list, current");
  // Sync events: Failures only ticked, its read held
  let holdEvents: ((r: Response) => void) | null = null;
  const app2 = createApp((p: string) => p.includes("failed=1") ? new Promise<Response>((r) => { holdEvents = r; }) : Promise.resolve(readAnswer(STATE, p)), () => new Date(NOW), "#observability/syncs");
  app2.show("#observability/syncs");
  await app2.poll();
  const syncs = app2.pages.get("syncs")! as unknown as { view(): Record<string, string>; input(t: unknown): unknown };
  const events = syncs.view()["syncs-events"]!;
  const ticking = Promise.resolve(syncs.input({ id: "syncs-failures-only", checked: true }));
  await settle();
  assert.match(syncs.view()["syncs-events"]!, /^<div class="reading" aria-busy="true">/, "the events read last stay, greyed, while Failures only is read");
  assert.ok(!syncs.view()["syncs-events"]!.includes("Asking Mason"), "never a blank");
  void events;
  holdEvents!(new Response(JSON.stringify({ events: [], keptDays: 7 }), { status: 200 }));
  await ticking;
  assert.ok(!syncs.view()["syncs-events"]!.includes("aria-busy"));
});
