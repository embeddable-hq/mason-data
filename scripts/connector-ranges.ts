#!/usr/bin/env node
/**
 * ARE THE HOSTED AGENTS' ADDRESS RANGES STILL THE ONES THEIR COMPANIES PUBLISH? (src/cli/address-presets.ts, issue 1115)
 *
 *   node scripts/connector-ranges.ts            reads each preset's source and says what drifted: exit 0 none, 1 drifted,
 *                                               3 a source could not be read (couldn't tell: never "no drift")
 *   node scripts/connector-ranges.ts --write    the same, and writes the ranges read into src/cli/address-presets.ts
 *
 * A source is read as its preset's `read` says: a page of the company's documentation, the CIDRs written under its
 * `heading` up to its `until` (the heading after it); or a JSON file of `prefixes`, each an `ipv4Prefix` or an
 * `ipv6Prefix`. Every range read is held to the one grammar of a user's ranges and written in its one form (src/duck/users.ts
 * `userRanges`); one that is not a range, or a file of another shape, is "could not read" (exit 3), never a drift. Mason
 * never runs this: the ranges ship with a release, and a change to them is a pull request. Run it before a release, or
 * from a scheduled CI job (proposed, not added: docs/DESIGN.md "An MCP server over HTTPS").
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ADDRESS_PRESETS, type AddressPreset } from "../src/cli/address-presets.ts";
import { MAX_RANGES, userRanges } from "../src/duck/users.ts";

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

/** The ranges of a JSON list of prefixes (`{ creationTime, prefixes: [{ ipv4Prefix } | { ipv6Prefix }, …] }`), as written,
 *  or what is wrong with it: anything else is "could not read", never an empty list. */
export function rangesOfPrefixes(text: string): string[] | string {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return "is not JSON"; }
  const prefixes = typeof v === "object" && v !== null ? (v as { prefixes?: unknown }).prefixes : undefined;
  if (!Array.isArray(prefixes)) return "has no prefixes list";
  const out: string[] = [];
  for (const [i, p] of prefixes.entries()) {
    const r = typeof p === "object" && p !== null ? (p as { ipv4Prefix?: unknown; ipv6Prefix?: unknown }) : {};
    const one = typeof r.ipv4Prefix === "string" ? r.ipv4Prefix : typeof r.ipv6Prefix === "string" ? r.ipv6Prefix : null;
    if (one === null) return `its prefix ${i + 1} has no ipv4Prefix or ipv6Prefix`;
    out.push(one);
  }
  return out.length === 0 ? "lists no prefix" : out;
}

/** Ranges read, in the form a user's ranges are kept (one address without its /32 or /128, each once), or why not. */
export function keptForm(ranges: readonly string[]): string[] | string {
  const r = userRanges(ranges);
  return "problem" in r ? `holds what a user's ranges cannot (at most ${MAX_RANGES}, each a range): ${r.problem}` : r.from;
}

/** The ranges as the module writes them: eight to a line under `ranges: [`, at the preset's indent. */
export function rangesLiteral(ranges: readonly string[], indent = "    "): string {
  if (ranges.length <= 4) return `ranges: [${ranges.map((r) => JSON.stringify(r)).join(", ")}]`;
  const lines: string[] = [];
  for (let i = 0; i < ranges.length; i += 8) lines.push(`${indent}  ${ranges.slice(i, i + 8).map((r) => JSON.stringify(r)).join(", ")},`);
  return `ranges: [\n${lines.join("\n")}\n${indent}]`;
}

/** The module's text with the preset `id`'s ranges written as `ranges`, or null when its `ranges: [ … ]` is not found. */
export function withRanges(source: string, id: string, ranges: readonly string[]): string | null {
  const at = source.indexOf(`id: ${JSON.stringify(id)},`);
  if (at < 0) return null;
  const start = source.indexOf("ranges: [", at);
  const end = start < 0 ? -1 : source.indexOf("]", start);
  if (end < 0) return null;
  return `${source.slice(0, start)}${rangesLiteral(ranges)}${source.slice(end + 1)}`;
}

async function read(p: AddressPreset): Promise<string[] | string> {
  const url = p.read.kind === "json" ? p.read.url : p.source;
  let res: Response;
  try { res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) }); }
  catch (e) { return `${url} could not be fetched: ${(e as Error).message}`; }
  if (res.status !== 200) return `${url} answered HTTP ${res.status}`;
  const text = await res.text();
  let ranges: string[];
  if (p.read.kind === "json") {
    const r = rangesOfPrefixes(text);
    if (typeof r === "string") return `${url} ${r}: read it by hand`;
    ranges = r;
  } else {
    const r = rangesUnder(pageText(text), p.read.heading, p.read.until);
    if (r === null) return `${url} has no "${p.read.heading}" followed by "${p.read.until}" any more: read it by hand, and change heading and until`;
    if (r.length === 0) return `${url} lists no range under "${p.read.heading}": read it by hand`;
    ranges = r;
  }
  const kept = keptForm(ranges);
  return typeof kept === "string" ? `${url} ${kept}` : kept;
}

async function main(): Promise<number> {
  const write = process.argv.includes("--write");
  let drifted = false, unread = false;
  let source = fs.readFileSync(FILE, "utf8");
  for (const p of ADDRESS_PRESETS) {
    const now = await read(p);
    if (typeof now === "string") { process.stderr.write(`${p.label}: ${now}\n`); unread = true; continue; }
    const added = now.filter((r) => !p.ranges.includes(r)), removed = p.ranges.filter((r) => !now.includes(r));
    if (added.length === 0 && removed.length === 0 && now.length === p.ranges.length) { process.stdout.write(`${p.label}: as published (${p.ranges.length} ranges)\n`); continue; }
    drifted = true;
    process.stdout.write(`${p.label}: DRIFTED — published now ${now.length} ranges${added.length ? `; added ${added.join(", ")}` : ""}${removed.length ? `; removed ${removed.join(", ")}` : ""} (${p.source})\n`);
    if (write) {
      const next = withRanges(source, p.id, now);
      if (next === null) { process.stderr.write(`${p.label}: its ranges: [ … ] is not found after id: ${JSON.stringify(p.id)} in ${FILE}: change them by hand\n`); unread = true; continue; }
      source = next;
    }
  }
  if (write && drifted) { fs.writeFileSync(FILE, source); process.stdout.write(`wrote ${FILE}: read the diff, and say the change in release-notes/next.md\n`); }
  return unread ? 3 : drifted ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
