/**
 * `MASON_UI_DEPLOY_DOCS_URL` (mason serve): WHERE THE PAGE SENDS A PERSON TO CHANGE A DEPLOYED PROJECT. When the
 * project's files are read-only because they were deployed (`/api/state` `sourcesReadOnlyKind`: `deployed`,
 * `unwritable`), the Tables page says so and links to the steps. By default that is the README's "Change a deployed
 * project" section (`DEPLOY_DOCS_DEFAULT`). A host that runs Mason for others can link to its own steps instead.
 *
 * The URL is read by the link back's ONE reading (src/cli/ui-back-link.ts `linkUrl`): a path from the host's root or an
 * `https://` / `http://` URL, printable ASCII, no user or password, at most 2048 characters. Anything else refuses the
 * start, never quoting the value. The page puts it in an attribute, escaped, opened in the same tab with no referrer.
 *
 * The run's state always says the URL the page links to (`pageDeployDocs`): the setting's, else the default. So the
 * default is written here alone, and the page holds no URL of its own.
 */
import { linkUrl } from "./ui-back-link.ts";

export const UI_DEPLOY_DOCS_URL_SETTING = "MASON_UI_DEPLOY_DOCS_URL";

/** The README's section on changing a deployed project, on the public repository (tests/conventions.test.ts holds
 *  its anchor to a heading of README.md). */
export const DEPLOY_DOCS_DEFAULT = "https://github.com/embeddable-hq/mason-data#change-a-deployed-project";

/** The setting as the environment says it: null when unset (or set empty), else the URL the page is given, or what is
 *  wrong with it. */
export function uiDeployDocsSetting(env: Readonly<Record<string, string | undefined>>): string | null | { problem: string } {
  const text = env[UI_DEPLOY_DOCS_URL_SETTING] ?? "";
  if (text === "") return null;
  return linkUrl(text, `${UI_DEPLOY_DOCS_URL_SETTING} is set`, "the link to the deploy steps");
}

/** The URL a run's page links to: the setting's, else the README's (a problem refused the start before the run reads it). */
export const deployDocsOf = (s: string | null | { problem: string }): string => typeof s === "string" ? s : DEPLOY_DOCS_DEFAULT;
