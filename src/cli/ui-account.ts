/**
 * `MASON_UI_ACCOUNT` (mason serve): WHO IS SIGNED IN TO THE HOST, at the foot of the sidebar. A host that signs people in
 * (a hosted service's console, a portal behind a reverse proxy) names the person, or the account, and links to where it
 * is managed or signed out of: `{"label": "ada@example.com", "url": "/account"}`. Unset, the page is as before.
 *
 * The URL is read by the link back's ONE reading (src/cli/ui-back-link.ts `linkUrl`): a path from the host's root or an
 * `https://` / `http://` URL, printable ASCII, no user or password, at most 2048 characters. The label is read by its
 * label's reading (`linkLabel`: one line of plain text, no control or format character, at most `BACK_LABEL_MAX`, 64,
 * characters), and trimmed; an empty one is refused. The object takes exactly the two keys, each a string, once: an
 * unknown key, a key written twice (JSON.parse keeps the last, silently) and a value of another type are refused. Every
 * problem refuses the start, on one line, never quoting the value or a key it does not take (either may be anything, a
 * secret too). The page renders the label as text and the URL as an attribute, never as HTML (src/web/app.js
 * `renderAccount`), in the same tab and sending no referrer, as the link back does.
 */
import { didYouMean } from "../lib/did-you-mean.ts";
import { linkLabel, linkUrl, type PageLink } from "./ui-back-link.ts";
import { writtenKeys } from "./ui-nav.ts";

export const UI_ACCOUNT_SETTING = "MASON_UI_ACCOUNT";
/** The longest MASON_UI_ACCOUNT read, in characters: its URL and label at their longest, with room for the JSON. */
export const ACCOUNT_TEXT_MAX = 4096;

/** What `/api/state` `pageAccount` says, and the page renders. */
export type PageAccount = PageLink;

/** An example of the value, said in every problem with its shape. */
const EXAMPLE = `{"label":"ada@example.com","url":"/account"}`;
const KEYS = ["label", "url"];

/** The account as the environment says it: null when unset (or set empty), else the label and the URL, or every problem. */
export function uiAccountSetting(env: Readonly<Record<string, string | undefined>>): PageAccount | null | { problem: string } {
  const at = UI_ACCOUNT_SETTING;
  const text = env[at] ?? "";
  if (text === "") return null;
  if (text.length > ACCOUNT_TEXT_MAX) return { problem: `${at} is ${text.length} characters, and it is at most ${ACCOUNT_TEXT_MAX}: name a shorter label and URL` };
  let v: unknown;
  // the parser's own message quotes the value: never said
  try { v = JSON.parse(text); } catch { return { problem: `${at} is not JSON: write ${EXAMPLE}` }; }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { problem: `${at} is not a JSON object: write ${EXAMPLE}` };
  const o = v as Record<string, unknown>;
  const problems: string[] = [];
  // the keys as written, every repeat kept (the same reading as MASON_UI_NAV_LINKS', over the object as a list of one)
  const written = writtenKeys(`[${text}]`).get(0) ?? [];
  const own = Object.keys(o);
  const distinct = [...new Set(written)];
  if (distinct.length !== own.length || distinct.some((k) => !own.includes(k))) {
    // the reading and JSON.parse disagree on what the keys are: refused, never guessed (fail closed)
    problems.push(`${at} could not be read key by key: write ${EXAMPLE}`);
  } else {
    const unknown = distinct.filter((k) => !KEYS.includes(k));
    if (unknown.length > 0) {
      const hint = unknown.length === 1 ? didYouMean(unknown[0]!, KEYS) : "";
      problems.push(`${at} has ${unknown.length === 1 ? "a key" : `${unknown.length} keys`} it does not take${hint}: it takes "label" and "url" alone`);
    }
    for (const k of KEYS) {
      const n = written.filter((w) => w === k).length;
      if (n > 1) problems.push(`${at} has "${k}" ${n === 2 ? "twice" : `${n} times`}, and JSON keeps only the last: write each key once`);
    }
  }
  let label: string | { problem: string };
  if (!Object.hasOwn(o, "label")) label = { problem: `${at} has no "label": give it the text the sidebar shows, ${EXAMPLE}` };
  else if (typeof o.label !== "string") label = { problem: `${at} has a "label" that is not a string: give it the text the sidebar shows, in quotes` };
  else if (o.label === "") label = { problem: `${at} has an empty "label": give it the text the sidebar shows` };
  else {
    const read = linkLabel(o.label, `${at}'s "label"`, "give it the text the sidebar shows");
    label = typeof read === "string" ? read.trim() : read;
  }
  const url = !Object.hasOwn(o, "url") ? { problem: `${at} has no "url": give it a path on this host (/account) or an https:// URL` }
    : typeof o.url !== "string" ? { problem: `${at} has a "url" that is not a string: give it a path on this host (/account) or an https:// URL, in quotes` }
      : linkUrl(o.url, `${at} has its "url" set`, "a link");
  for (const x of [label, url]) if (typeof x !== "string") problems.push(x.problem);
  if (problems.length > 0) return { problem: problems.join("; ") };
  return { label: label as string, url: url as string };
}

/** The account a run's page is given: the setting's, else none (a problem refused the start before the run reads it). */
export const accountOf = (s: PageAccount | null | { problem: string }): PageAccount | null => s !== null && !("problem" in s) ? s : null;
