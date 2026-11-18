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
 * A company publishes its list one of two ways, and `read` says which: written on a documentation page, under a heading
 * (`{ kind: "page", heading, until }`: Anthropic's), or as a JSON file the page links to (`{ kind: "json", url }`, its
 * `prefixes` each an `ipv4Prefix` or an `ipv6Prefix`: OpenAI's, about 300 ranges). The ranges are written here as a
 * user's ranges are kept (src/duck/users.ts `userRanges`: one address without its `/32`), so a user given a company's
 * list is shown as that company's.
 */

export interface AddressPreset {
  /** its name in /api/state (the page's choice carries its ranges, `preset:<range>,…`) */
  id: string;
  /** the choice's words: the product that calls from these servers, under "A hosted agent's servers" (never a company's
   *  name alone, which a person using its desktop app took for theirs: issue 1155) */
  label: string;
  /** the product's short name, in a user's row: "from <name>'s servers (N ranges)" */
  name: string;
  /** the company's documentation page that publishes the list (or names the file that does) */
  source: string;
  /** how the list is read again: the CIDRs on `source` under `heading`, up to `until` (the heading after it); or the
   *  prefixes of the JSON file at `url` */
  read: { kind: "page"; heading: string; until: string } | { kind: "json"; url: string };
  /** the ranges, as `mason user from` takes them */
  ranges: readonly string[];
}

export const ADDRESS_PRESETS: readonly AddressPreset[] = [
  {
    id: "claude",
    label: "claude.ai",
    name: "claude.ai",
    source: "https://platform.claude.com/docs/en/api/ip-addresses",
    read: { kind: "page", heading: "Outbound IP addresses", until: "Phased out IP addresses" },
    // "These are the stable IP addresses that Anthropic uses for outbound requests (for example, when making MCP tool
    // calls to external servers)." Read 2026-11-17.
    ranges: ["160.79.104.0/21", "153.61.208.0/20"],
  },
  {
    id: "openai",
    label: "ChatGPT on the web",
    name: "ChatGPT",
    source: "https://developers.openai.com/api/docs/guides/ip-addresses",
    // "Outbound IP addresses": "ChatGPT integrations — Plugins, connectors, GPT Actions, and agentic commerce —
    // [ChatGPT connectors]", the file below. Its creationTime 2026-11-06T18:26:55; read 2026-11-17.
    read: { kind: "json", url: "https://openai.com/chatgpt-connectors.json" },
    ranges: [
      "100.31.168.162", "102.37.57.54", "104.192.219.204/30", "104.208.184.192/28", "104.210.139.192/28", "104.210.139.224/28", "108.179.20.6/31", "112.220.228.112/29",
      "115.42.241.224/29", "12.105.90.64/27", "12.108.172.96/28", "12.117.245.68/30", "12.12.47.194", "12.12.56.224/28", "12.12.56.24/29", "12.12.56.240/28",
      "12.12.56.32/29", "12.129.184.64/26", "12.162.186.200/29", "12.77.42.78", "12.79.201.188/30", "12.79.202.152/30", "12.79.202.156/30", "12.79.202.228/30",
      "12.79.202.232/30", "12.79.225.144/30", "12.79.34.30", "128.177.174.162", "128.177.85.168/30", "13.223.161.115", "13.237.176.161", "13.238.110.96",
      "13.65.138.112/28", "13.67.72.16/28", "13.71.2.208/28", "13.71.25.29", "13.76.116.80/28", "13.76.32.208/28", "13.83.237.176/28", "130.33.24.99",
      "132.196.82.48/28", "134.138.52.16/28", "134.138.52.64/28", "134.138.57.64/28", "134.138.57.80/28", "134.149.233.80/28", "134.33.102.192/28", "135.116.136.160/28",
      "135.13.64.240/28", "135.220.208.92", "135.220.40.201", "135.220.73.208/28", "135.222.99.32/28", "135.234.27.89", "135.237.133.48/28", "137.135.191.176/28",
      "145.132.136.96/28", "148.109.10.28/30", "148.109.36.240/28", "148.76.185.192/27", "149.97.160.16/28", "15.168.252.168", "152.44.170.32/29", "159.180.234.92/30",
      "172.162.248.64/28", "172.167.161.96", "172.167.32.228", "172.170.1.80/28", "172.170.225.0/28", "172.170.241.80/28", "172.171.234.186", "172.172.206.48/28",
      "172.175.152.224/28", "172.177.53.240/28", "172.183.143.224/28", "172.191.238.68", "172.191.70.179", "172.192.112.208/28", "172.198.58.176/28", "172.198.79.112/28",
      "172.199.137.80/28", "172.203.39.49", "172.204.96.80/28", "172.206.38.240/28", "172.207.1.32/28", "172.207.173.200", "172.214.226.198", "172.215.215.32/28",
      "173.195.76.0/26", "18.218.234.253", "180.222.194.124/30", "184.73.124.134", "191.232.238.96/28", "191.233.251.27", "191.234.167.144/28", "191.237.249.64/28",
      "194.46.223.16/28", "195.171.64.176/28", "199.241.201.152/29", "199.47.142.0/23", "20.102.212.144/28", "20.125.112.224/28", "20.125.40.252", "20.162.96.163",
      "20.168.48.117", "20.168.7.192/28", "20.169.78.48/28", "20.169.78.64/28", "20.169.86.224/28", "20.170.184.16/28", "20.170.184.32/28", "20.170.184.48/28",
      "20.170.184.64/28", "20.170.184.80/28", "20.171.137.175", "20.172.29.32/28", "20.184.36.134", "20.203.144.245", "20.206.101.192/28", "20.212.62.208/28",
      "20.215.187.208/28", "20.215.219.208/28", "20.219.124.186", "20.219.161.192/28", "20.219.184.96/28", "20.227.140.32/28", "20.228.106.176/28", "20.235.87.224/28",
      "20.241.32.36", "20.249.63.208/28", "20.250.136.64/28", "20.254.201.208/28", "20.44.100.224/28", "20.45.178.144/28", "20.55.229.144/28", "20.57.199.192/28",
      "20.63.221.64/28", "20.74.221.21", "20.78.130.48/28", "20.98.18.80/28", "203.125.229.136/29", "203.149.223.128/29", "208.184.8.104/29", "208.184.8.84/30",
      "208.52.97.112/29", "208.69.43.136/29", "208.80.35.32/27", "209.247.142.56/30", "209.247.151.176/28", "209.249.246.178/31", "209.249.37.128/26", "213.122.44.84/31",
      "216.64.170.234", "217.111.182.45", "217.111.242.24/29", "23.101.217.176/28", "23.102.141.32/28", "23.98.186.64/28", "23.98.186.96/28", "24.82.185.0/29",
      "3.12.200.18", "3.140.2.201", "4.14.111.0/28", "4.151.119.48/28", "4.151.200.38", "4.151.71.176/28", "4.155.146.196", "4.17.25.128/29",
      "4.185.216.109", "4.189.118.208/28", "4.19.160.0/28", "4.197.115.112/28", "4.197.172.116", "4.197.64.0/28", "4.197.64.48/28", "4.201.232.64/28",
      "4.205.128.176/28", "4.217.235.100", "4.218.24.64/28", "4.226.200.16/28", "4.226.226.32/28", "4.245.198.13", "4.38.166.228/30", "4.53.139.144/28",
      "4.7.10.112/30", "4.7.11.196/30", "40.118.236.137", "40.119.36.240/28", "40.122.118.119", "40.122.118.202", "40.122.118.93", "40.124.161.0/28",
      "40.88.27.77", "43.202.230.227", "44.221.134.118", "44.249.227.138", "45.147.211.96/29", "48.218.181.198", "48.221.184.80/28", "48.221.184.96/28",
      "48.221.40.176/28", "50.145.17.208/30", "50.145.17.212/30", "50.145.17.216/29", "50.145.17.224/29", "50.151.105.128/30", "50.151.105.136/29", "50.213.205.80/29",
      "50.235.235.72/29", "51.4.112.173", "51.57.0.96/28", "51.57.158.112/28", "51.59.24.64/28", "51.59.24.80/28", "51.59.48.80/28", "52.119.123.85",
      "52.143.181.161", "52.148.129.32/28", "52.165.212.48/28", "52.17.188.55", "52.172.129.160/28", "52.173.221.16/28", "52.173.234.16/28", "52.173.234.80/28",
      "52.190.137.144/28", "52.190.137.16/28", "52.190.139.48/28", "52.190.142.64/28", "52.190.251.112/28", "52.2.184.223", "52.208.217.159", "52.231.30.48/28",
      "52.231.39.144/28", "52.242.132.224/28", "52.242.132.240/28", "52.255.109.144/28", "52.255.109.80/28", "52.255.109.96/28", "52.255.111.0/28", "52.43.161.225",
      "52.6.94.121", "54.180.197.31", "54.227.131.66", "56.155.71.179", "57.133.92.112/31", "57.154.174.112/28", "57.154.187.32/28", "61.105.58.228/30",
      "62.96.221.184/29", "64.124.191.96/28", "64.124.21.196", "64.71.12.112/28", "66.193.99.66", "67.207.103.240/28", "68.154.28.96/28", "68.155.152.41",
      "68.220.57.64/28", "70.153.32.16/28", "70.153.32.32/28", "70.156.152.96/28", "72.146.20.246", "74.161.200.96/28", "74.224.217.64/28", "74.226.253.160/28",
      "74.248.148.7", "74.248.37.160/28", "74.7.35.112/28", "74.7.35.48/28", "74.7.36.64/28", "74.7.36.80/28", "74.7.36.96/28", "76.77.188.112/29",
      "77.75.96.48/29", "79.244.198.212/30", "8.244.149.100/30", "80.169.53.32/28", "85.211.128.16/28", "85.211.128.32/28", "9.129.0.0/16", "9.160.128.16/28",
      "9.160.128.64/28", "9.160.96.16/28", "9.205.128.32/28", "9.205.128.48/28", "9.205.8.48/28", "9.205.8.64/28", "9.234.96.192/28", "9.234.97.96/28",
      "98.87.72.221",
    ],
  },
];

/** The presets as `/api/state` carries them to the page: what a choice shows and sends, no more. */
export const presetsForPage = (): Array<{ id: string; label: string; name: string; ranges: string[] }> =>
  ADDRESS_PRESETS.map((p) => ({ id: p.id, label: p.label, name: p.name, ranges: [...p.ranges] }));
