/**
 * THE TOOLS A PERSON CONNECTS TO MASON, in one list: each a name, a kind and the tool's own page on connecting it to
 * PostgreSQL (`guide`). The web page's Users page offers them in its add form's "For" choice and links the guide from
 * the card of a user just added (src/web/pages/users.js); the run serves them as data (`GET /api/tools`,
 * src/cli/run-server.ts), so no URL is written in src/web. A tool is only that: no form, no field names of its own —
 * every tool connects with the same URL, user and password, and its guide says where they go.
 *
 * `id` is a valid user name (src/duck/users.ts USER_NAME_RE): the name the form suggests for the tool's user.
 */
export type ToolKind = "sql-client" | "bi" | "embedded";
export interface ConnectTool { id: string; name: string; kind: ToolKind; guide: string }

/** The kinds in the order the page groups them, each with its group's label. */
export const TOOL_KINDS: ReadonlyArray<{ kind: ToolKind; label: string }> = [
  { kind: "sql-client", label: "SQL clients" },
  { kind: "bi", label: "BI tools" },
  { kind: "embedded", label: "Embedded analytics" },
];

const tool = (id: string, name: string, kind: ToolKind, guide: string): ConnectTool => ({ id, name, kind, guide });

export const CONNECT_TOOLS: readonly ConnectTool[] = [
  tool("psql", "psql", "sql-client", "https://www.postgresql.org/docs/current/app-psql.html"),
  tool("datagrip", "DataGrip", "sql-client", "https://www.jetbrains.com/help/datagrip/postgresql.html"),
  tool("dbeaver", "DBeaver", "sql-client", "https://dbeaver.com/docs/dbeaver/Database-driver-PostgreSQL/"),
  tool("pgadmin", "pgAdmin", "sql-client", "https://www.pgadmin.org/docs/pgadmin4/latest/connecting.html"),
  tool("tableplus", "TablePlus", "sql-client", "https://tableplus.com/docs/gui-tools/manage-connections"),
  tool("superset", "Apache Superset", "bi", "https://superset.apache.org/user-docs/databases/supported/postgresql"),
  tool("grafana", "Grafana", "bi", "https://grafana.com/docs/grafana/latest/datasources/postgres/"),
  tool("hex", "Hex", "bi", "https://learn.hex.tech/docs/connect-to-data/data-connections/setup-guides/connect-to-postgres"),
  tool("looker", "Looker", "bi", "https://docs.cloud.google.com/looker/docs/db-config-postgresql"),
  tool("looker_studio", "Looker Studio", "bi", "https://docs.cloud.google.com/data-studio/connect-to-postgresql"),
  tool("metabase", "Metabase", "bi", "https://www.metabase.com/docs/latest/databases/connections/postgresql"),
  tool("power_bi", "Power BI", "bi", "https://learn.microsoft.com/en-us/power-query/connectors/postgresql"),
  tool("sigma", "Sigma", "bi", "https://help.sigmacomputing.com/docs/connect-to-postgresql"),
  tool("tableau", "Tableau", "bi", "https://help.tableau.com/current/pro/desktop/en-us/examples_postgresql.htm"),
  tool("trevor", "Trevor.io", "bi", "https://guide.trevor.io/hc/en-us/articles/6199515026717-How-to-connect"),
  tool("embeddable", "Embeddable", "embedded", "https://docs.embeddable.com/data/credentials#postgres"),
  tool("luzmo", "Luzmo", "embedded", "https://academy.luzmo.com/article/osfz7m3g"),
  tool("sisense", "Sisense", "embedded", "https://docs.sisense.com/main/SisenseLinux/connecting-to-postgresql.htm"),
];

/** `GET /api/tools`' answer: the tools and their kinds' labels, in the page's order. It never changes during a run. */
export const toolsAnswer = (): { tools: readonly ConnectTool[]; kinds: typeof TOOL_KINDS } => ({ tools: CONNECT_TOOLS, kinds: TOOL_KINDS });
