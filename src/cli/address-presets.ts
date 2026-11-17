/**
 * A HOSTED AGENT'S PUBLISHED ADDRESSES (issue 1115): the address ranges a company publishes for the requests its
 * connectors make to an MCP server, offered by the web page's "Connects from" as a choice of their own, so a user held
 * to them connects through `mason serve`'s MCP endpoint from that agent alone (the address judged is the client's:
 * the peer, or a named relay's X-Forwarded-For entry, src/cli/mcp-http.ts `clientOf`).
 *
 * THE RANGES SHIP WITH THE RELEASE, copied from each company's page as it stood when the list was last brought up to
 * date; Mason never fetches them at run time (a run reads nothing from a vendor, and a page that changed under a run
 * would change who connects without anyone deciding it). `scripts/connector-ranges.ts` reads each `source` again and
 * says whether the list here has drifted, naming what was added and removed (exit 1), and `--write` brings it up to
 * date: a change is a pull request like any other, reviewed and released. Run it before a release; a scheduled CI job
 * running it weekly is the proposal (docs/DESIGN.md "An MCP server over HTTPS").
 *
 * OpenAI's list for ChatGPT is not here yet: its pages could not be read from where this list was written, and a range
 * is never guessed. Its entry is added, with its source, once its published list is read.
 */

export interface AddressPreset {
  /** its name in /api/state (the page's choice carries its ranges, `preset:<range>,…`) */
  id: string;
  /** the choice's words */
  label: string;
  /** where the company publishes the list */
  source: string;
  /** the heading of the source the list is read under, and the next one, which ends it: to find it again */
  heading: string;
  until: string;
  /** the ranges, as `mason user from` takes them */
  ranges: readonly string[];
}

export const ADDRESS_PRESETS: readonly AddressPreset[] = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    source: "https://platform.claude.com/docs/en/api/ip-addresses",
    heading: "Outbound IP addresses",
    until: "Phased out IP addresses",
    // "These are the stable IP addresses that Anthropic uses for outbound requests (for example, when making MCP tool
    // calls to external servers)." Read 2026-11-17.
    ranges: ["160.79.104.0/21", "153.61.208.0/20"],
  },
];

/** The presets as `/api/state` carries them to the page: what a choice shows and sends, no more. */
export const presetsForPage = (): Array<{ id: string; label: string; ranges: string[] }> =>
  ADDRESS_PRESETS.map((p) => ({ id: p.id, label: p.label, ranges: [...p.ranges] }));
