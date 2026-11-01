#!/usr/bin/env node
/**
 * Stop hook: a coordinator leaves a wake-up for what it waits on (CLAUDE.md "A coordinator never ends a turn without a
 * wake-up for what it waits on"). It reads the CURRENT turn of the session's transcript (JSONL), the tool uses after
 * the last prompt a person typed: when the last merge queued (`gh pr merge … --auto`) or message sent to another
 * session (`mcp__ccd_session_mgmt__send_message`) has no background job started after it that is still running, it WARNS. A
 * SendMessage to a sub-agent is no trigger: a sub-agent's end wakes the session. A background job is a Bash call with
 * run_in_background or a Monitor; it is still running until a `<task-notification>` names its tool use.
 *
 * A heuristic, so it never blocks: the warning is a `systemMessage` the person sees, and the turn ends as it would.
 * Silent when stop_hook_active (a stop hook is already continuing the turn), when the Stop input lists a background
 * task or a session cron (something will wake the session), and when the transcript cannot be read or parsed: a
 * warning hook must never fail a stop.
 */
import * as fs from "node:fs";
import { readInput } from "./shell.ts";

interface ToolUse { id: string; name: string; input: Record<string, unknown>; line: number }

interface Entry { type?: unknown; isMeta?: unknown; message?: { content?: unknown } }

/**
 * A prompt a person typed, which starts a turn: a string, or blocks with at least one `text` and no `tool_result` (an
 * image may ride beside the text); never a harness's note (isMeta) or a task's notification.
 */
function isPrompt(entry: Entry): boolean {
  if (entry.type !== "user" || entry.isMeta === true) return false;
  const content = entry.message?.content;
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const blocks = content as { type?: unknown; text?: unknown }[];
    const texts = blocks.filter((b) => b.type === "text");
    if (texts.length > 0 && !blocks.some((b) => b.type === "tool_result")) text = texts.map((b) => String(b.text ?? "")).join("");
  }
  return text !== undefined && !text.trimStart().startsWith("<task-notification>");
}

/** The tool uses of the current turn, in order. */
function toolUses(lines: string[]): ToolUse[] {
  const uses: ToolUse[] = [];
  lines.forEach((raw, line) => {
    if (raw.trim() === "") return;
    let entry: Entry;
    try {
      entry = JSON.parse(raw) as typeof entry;
    } catch {
      // The transcript is written as the session runs, so its last line may be half written: that line is skipped.
      return;
    }
    if (isPrompt(entry)) { uses.length = 0; return; } // a new turn: what came before it was resolved or warned of
    const content = entry.type === "assistant" ? entry.message?.content : undefined;
    if (!Array.isArray(content)) return;
    for (const block of content as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }[]) {
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        uses.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown>, line });
      }
    }
  });
  return uses;
}

/** A message to another session; another connector's `…__send_message` (an email) is no lead at work. */
const SESSION_SEND = "mcp__ccd_session_mgmt__send_message";
const QUEUED_MERGE = /\bgh\s+pr\s+merge\b[^;&|\n]*--auto\b/;

/** What the session waits on with nothing to wake it, or undefined. */
function unwatched(lines: string[]): string | undefined {
  const uses = toolUses(lines);
  let trigger: { use: ToolUse; what: string } | undefined;
  for (const use of uses) {
    if (use.name === "Bash" && typeof use.input["command"] === "string" && QUEUED_MERGE.test(use.input["command"])) {
      trigger = { use, what: "a merge is queued" };
    } else if (use.name === SESSION_SEND) {
      trigger = { use, what: "a lead is working" };
    }
  }
  if (trigger === undefined) return undefined;
  const after = uses.slice(uses.indexOf(trigger.use) + 1);
  const running = after.some((u) => (u.name === "Monitor" || (u.name === "Bash" && u.input["run_in_background"] === true))
    && !lines.slice(u.line + 1).some((l) => l.includes(`<tool-use-id>${u.id}</tool-use-id>`)));
  return running ? undefined : trigger.what;
}

const input = readInput();
const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
if (input.stop_hook_active !== true && !nonEmpty(input.background_tasks) && !nonEmpty(input.session_crons)
  && typeof input.transcript_path === "string") {
  let what: string | undefined;
  try {
    what = unwatched(fs.readFileSync(input.transcript_path, "utf8").split("\n"));
  } catch {
    // An unreadable or half-written transcript says nothing either way; a warning that cannot tell stays silent.
    what = undefined;
  }
  if (what !== undefined) {
    process.stdout.write(`${JSON.stringify({ systemMessage: `${what} and no background wait is running: leave a bounded wait (CLAUDE.md "A coordinator never ends a turn without a wake-up")` })}\n`);
  }
}
