#!/usr/bin/env node
/**
 * ARE THE HOSTED AGENTS' ADDRESS RANGES STILL THE ONES THEIR COMPANIES PUBLISH? (src/cli/address-presets.ts, issue 1115)
 *
 *   node scripts/connector-ranges.ts            reads each preset's source and says what drifted: exit 0 none, 1 drifted,
 *                                               3 a source could not be read (couldn't tell: never "no drift")
 *   node scripts/connector-ranges.ts --write    the same, and writes the ranges read into src/cli/address-presets.ts
 *
 * Each source is a page of the company's documentation. The ranges are the CIDRs written under the preset's `heading`,
 * up to its `until`, the heading after it. Mason never runs this: the
 * ranges ship with a release, and a change to them is a pull request. Run it before a release, or from a scheduled CI
 * job (proposed, not added: docs/DESIGN.md "An MCP server over HTTPS").
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ADDRESS_PRESETS, type AddressPreset } from "../src/cli/address-presets.ts";

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "address-presets.ts");
const CIDR = /\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\/\d{1,3}\b/gi;

/** A page's text: its tags and scripts gone, entities read, white space one space. */
export function pageText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ");
}

/** The ranges under `heading` in a page's text: from its first place to the first `until` after it (null: either is gone). */
export function rangesUnder(text: string, heading: string, until: string): string[] | null {
  const at = text.indexOf(heading);
  if (at < 0) return null;
  const rest = text.slice(at + heading.length);
  const end = rest.indexOf(until);
  if (end < 0) return null;
  return [...new Set(rest.slice(0, end).match(CIDR) ?? [])];
}

async function read(p: AddressPreset): Promise<string[] | string> {
  let res: Response;
  try { res = await fetch(p.source, { redirect: "follow", signal: AbortSignal.timeout(20_000) }); }
  catch (e) { return `could not be fetched: ${(e as Error).message}`; }
  if (res.status !== 200) return `answered HTTP ${res.status}`;
  const ranges = rangesUnder(pageText(await res.text()), p.heading, p.until);
  if (ranges === null) return `has no "${p.heading}" followed by "${p.until}" any more: read it by hand, and change heading and until`;
  if (ranges.length === 0) return `lists no range under "${p.heading}": read it by hand`;
  return ranges;
}

async function main(): Promise<number> {
  const write = process.argv.includes("--write");
  let drifted = false, unread = false;
  let source = fs.readFileSync(FILE, "utf8");
  for (const p of ADDRESS_PRESETS) {
    const now = await read(p);
    if (typeof now === "string") { process.stderr.write(`${p.label}: ${p.source} ${now}\n`); unread = true; continue; }
    const added = now.filter((r) => !p.ranges.includes(r)), removed = p.ranges.filter((r) => !now.includes(r));
    if (added.length === 0 && removed.length === 0) { process.stdout.write(`${p.label}: as published (${p.ranges.join(", ")})\n`); continue; }
    drifted = true;
    process.stdout.write(`${p.label}: DRIFTED — published now ${now.join(", ")}${added.length ? `; added ${added.join(", ")}` : ""}${removed.length ? `; removed ${removed.join(", ")}` : ""} (${p.source})\n`);
    if (write) {
      const old = `ranges: [${p.ranges.map((r) => JSON.stringify(r)).join(", ")}]`;
      if (!source.includes(old)) { process.stderr.write(`${p.label}: its ranges are not written as ${old} in ${FILE}: change them by hand\n`); unread = true; continue; }
      source = source.replace(old, `ranges: [${now.map((r) => JSON.stringify(r)).join(", ")}]`);
    }
  }
  if (write && drifted) { fs.writeFileSync(FILE, source); process.stdout.write(`wrote ${FILE}: read the diff, and say the change in release-notes/next.md\n`); }
  return unread ? 3 : drifted ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
