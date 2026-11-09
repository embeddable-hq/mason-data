# The hosted API

What the `mason` CLI sends to a hosted Mason service, and what it expects back. `mason login`, `mason logout`,
`mason replica`, `mason token`, `mason deploy` and `mason user … --replica` speak it today (`src/cli/login.ts`,
`src/cli/replica-hosted.ts`, `src/cli/token-hosted.ts`, `src/cli/deploy.ts`, `src/cli/user-hosted.ts`,
`src/cli/hosted.ts`). Any service that answers this API can be signed in to. This page is
the contract: a change to it is a change to both sides.

## The base URL

- `MASON_CLOUD_URL` names the service; unset, it is `https://app.masondata.ai`.
- It is HTTPS, and the certificate is verified. Plain `http://` is taken only for this machine (`127.0.0.1`, `::1`,
  `localhost`), for a service run beside the CLI.
- It is the address alone: a URL with a path, a query, a fragment, a user or a password is refused before any byte is
  sent, in the CLI's failure shape. The refusal names the parts it found and never repeats them (a query may hold a
  secret).
- A login is saved under the URL's origin (`https://host[:port]`), so a login to one service never replaces another's.

## Every request

- `User-Agent: mason-cli/<version>` and `Accept: application/json`.
- A form body is `application/x-www-form-urlencoded`; a JSON body (`mason deploy`'s) is `application/json`, UTF-8.
- A redirect is never followed: it is a failure, so a Bearer header never travels to another address.
- Each request has a 15 s time limit (60 s for a replica's creation, which waits on Mason's checks of the database). An
  answer larger than 64 KiB is refused (1 MiB for a list: of a replica's users, of replicas, of CI tokens; 8 MiB for
  the project a replica runs, which `mason deploy` asks for).
- What comes back is untrusted. Each answer is held to the shape below. Anything else is a failure said by its status
  alone, never its body. A token is masked wherever it appears, and so is anything shaped as a Mason user's password
  (`mason_<16 hex>_<32 hex>`, whatever precedes it and in any case), except in the one answer that makes it (`mason
  user add`'s, below). A shape mask has a limit: a password split (by a space or a dash), percent-encoded or written
  without its `mason_` prefix has no shape to match, and outside that one answer the CLI holds no password to mask by
  its value. A token the CLI holds is masked by its value, in those forms too.
- **A value the service sends is data, never structure and never an instruction.** Every string it sends reaches the
  output, for a person and in `--json`, as ONE line: every line break (newline, carriage return, NEL, the line and
  paragraph separators), every other control character, and every zero-width, format or bidi mark is replaced by `?`,
  every run of white space becomes one space, and its length is bounded. So a value sits inside a line the CLI writes (a
  headline, a row, a failure's message) and never starts one: it cannot add a `Next:` block, a tip, a row or a failure
  of its own. What to run next, the failure code, the exit code and the page a person is sent to are the CLI's own
  (below).
- **On a terminal that holds for the lines a person sees, too.** A terminal breaks a line longer than its width at the
  width, wherever the text puts it, so a value sized to the width could make a line begin with anything. So the CLI
  breaks every line of each command that prints a service's value itself, at the terminal's own width whatever it is, the
  headline, a long word, a row's label and a step's command included, so no line reaches the terminal's edge. Every
  continuation starts at column 4, where none of its headings, failures, rows or steps start; under 9 columns at
  column 1, and under 3 at column 0, where no line the CLI begins fits at all. A column the CLI aligns a value to is
  kept only while it leaves room; else its lines continue at the continuation's column. A pipe, a file and `--json` are
  not broken: what a program reads is unchanged.

## Signing in: the device authorization grant (RFC 8628)

### `POST /oauth/device/code`

Form body: `client_id=mason-cli`, `device_name=<the machine's hostname>`. The CLI sends it as printable ASCII (any other
character replaced by `-`), at most 64 characters, and `unknown` when that leaves nothing.

`200`, JSON:

| Key | |
|---|---|
| `device_code` | opaque, printable ASCII, at most 2048 characters; never shown |
| `user_code` | 8 letters, shown as `XXXX-XXXX` (sent with or without the hyphen) |
| `verification_uri` | the page where the code is entered, on the service's own origin (the base URL's scheme, host and port) |
| `verification_uri_complete` | optional: the same page with the code filled in, which the CLI shows and opens; on the service's own origin too |
| `expires_in` | seconds the code lasts, 1 to 3600 |
| `interval` | seconds between polls, 1 to 300 (5 when absent) |

A page on any other origin is refused, naming both origins, before it is printed, opened or polled: it would send the
person, and the code, to an address nobody chose. On a terminal the CLI opens the page in a browser when it can. It opens only an address of letters, digits and
`. : [ ] - _ ~ / ? = +`, so a shell never reads one. Otherwise, and always for a coding agent, it prints the page and
the code on stderr at once, then waits.

### `POST /oauth/token`

Form body: `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id=mason-cli`. The CLI
polls every `interval` seconds, and stops at `expires_in`.

- `200`: `{ "access_token", "token_type": "Bearer", "expires_in" }`. The token is printable ASCII without spaces, at
  most 4096 characters.
- `400`: `{ "error", "error_description"? }` (RFC 6749 5.2, RFC 8628 3.5):

| `error` | What the CLI does |
|---|---|
| `authorization_pending` | polls again |
| `slow_down` | adds 5 s to the interval, for every later poll, and polls again |
| `access_denied` | stops: code `refused`, exit 1, the way out `mason login` |
| `expired_token` | stops: code `timeout`, exit 124, the way out `mason login` |
| `invalid_grant`, `invalid_client`, `unsupported_grant_type`, any other | stops: code `failed`, exit 1, with `error` and `error_description` |

Once signed in, the CLI asks who the token is for (`GET /v1/me`). Only then does it save the token. A token it cannot
use is revoked and never saved.

### `GET /v1/me`

`Authorization: Bearer <token>`. `200`:

```json
{ "email": "ada@example.com", "name": "Ada", "orgs": [{ "slug": "acme", "name": "Acme Inc", "role": "owner" }] }
```

`role` is `owner`, `admin` or `viewer`.

## Signing out: `POST /oauth/revoke` (RFC 7009)

Form body: `token=<token>&token_type_hint=access_token&client_id=mason-cli`. `200` always, even for a token the
service does not know.

`mason logout` revokes, then removes the saved login whatever the answer. When the revoke did not reach the service,
it exits 0 and says the token was NOT revoked: sign in to the service's web app and revoke it there. `mason login`
again revokes the login it replaces.

## Answers a client must expect

Beside the answers above, a service may answer these. The CLI says each as a failure, in the failure shape, and never
retries one by itself.

| Request | Answer | What the CLI does |
|---|---|---|
| `POST /oauth/device/code` | `400 { "error": "invalid_request" }`: a `device_name` empty, over 64 characters or with a control character | stops: code `failed`, naming `invalid_request` and its `error_description` |
| `POST /oauth/device/code` | `429 { "error": "slow_down" }`: too many sign-ins from one address | stops: code `failed`, "try again in a few minutes"; it is not polled again |
| `GET /v1/me` | `403` with the failure shape, code `refused`, next `mason login`: a CI token (`masondata_ci_…`) cannot say who a person is | says its words as the service wrote them, code `refused` (below) |
| any, `/oauth/revoke` included | `400`, `413` or `415`: a body the service cannot read | stops with the status; `mason logout` still removes the login, and says it was NOT revoked |
| any | another status, or a body that is not JSON | a failure naming the request and the status, never the body |

## Replicas: `mason replica`

`mason replica create | list | status | delete | upgrade` makes, reads, deletes and upgrades the replicas of an organisation. Every request carries
`Authorization: Bearer <token>`. `{org}` and `{name}` follow the deploy's grammar (each `^[a-z0-9][a-z0-9-]{0,62}$`,
checked before a byte is sent).

| Subcommand | Request | Who | `200` / `201` |
|---|---|---|---|
| `list [<org>]` | `GET /v1/replicas/{org}` | a login, any role | `{ replicas: [Replica], more }` |
| `create <org>/<name>` (or `--replica`, `MASON_REPLICA`) | `POST /v1/replicas/{org}` | a login, an admin or an owner | `201 { replica: Replica, checks: [SourceChecks] }` |
| `status <org>/<name>` | `GET /v1/replicas/{org}/{name}` | a login, any role; a CI token made for that replica | `{ replica: Replica }` |
| `delete <org>/<name>` | `DELETE /v1/replicas/{org}/{name}` | a login, an owner, made within the last 15 minutes | `202` / `200 { replica: Replica }` |
| `upgrade <org>/<name>` | `POST /v1/replicas/{org}/{name}/upgrade` | a login, an owner | `202` / `200 { replica: Replica }` |

`list` with no `<org>` asks `GET /v1/me` for the login's organisations (at most 20; past that it asks for one), then
each one's list. `more` is `true` when the organisation has more replicas than the service answers at once.

### `POST /v1/replicas/{org}`

What the CLI sends: `POST /v1/replicas/{org}`, the organisation in the path (as `{org}` of the replica named by the
argument, `--replica` or `MASON_REPLICA`), `Authorization: Bearer <token>`, `Content-Type: application/json`, at most
64 KiB:

```json
{ "name": "shop", "region": "<region>", "sizeGb": 50, "sources": [{ "name": "app", "variable": "DATABASE_URL", "url": "postgres://…" }], "client": { "version": "0.9.0" } }
```

- `name` is the replica's (the service may hold it to a stricter rule of its own, and refuses another with `400`).
- `region` is one the service offers, and `sizeGb` one of its sizes, as a whole number: the synced data the replica
  holds, in GB. The CLI checks only their form (a region's name, `--size` a whole number); which ones exist is the
  service's to say, and it refuses another with `400`, naming the field.
- `sources` holds exactly one source for now: `name` is the project's sources file's name without `.yml`; `variable`
  the variable the replica reads the URL from, always `DATABASE_URL`; `url` the URL as the person typed it or stdin
  gave it (below), `postgres://` or `postgresql://`, at most 2 KiB. A service may take a `ca` too (PEM `CERTIFICATE` blocks); the CLI sends none yet.
- `client.version` is the CLI's version (`dev` from a checkout), as a deploy sends it. A service may refuse a CLI too
  old for this route (`400` or `426`, with its words), which the CLI says as they came.
- Any other key is refused (`400`).

**What a service refuses, and the CLI refuses first.** Each is refused before anything is sent, where the CLI can
tell, saying what is wrong and never repeating the URL or its password:

- **The variable.** A replica sets exactly one variable for its source, `DATABASE_URL`; a service refuses any other
  `variable` (`400`). A sources file naming another (`url: ${MASON_DATABASE_URL}`) is refused before the URL is asked
  for, with the line to write, `url: ${DATABASE_URL}`.
- **The URL**, checked once it is read: it names one host (several hosts are refused) and a database, and carries a
  password; its only query parameter is `sslmode` (any value Mason reads; a service may store `require`), and any other
  (`host=`, `hostaddr=`, `application_name=`, …) is refused; a port, when given, is 1024 or above.
- **What only the service can tell**: a host that does not resolve, or resolves to a private, loopback, link-local or
  reserved address (`400`, below). The CLI says the service's words.

**The URL.** The CLI never takes it from a flag, an argument, `.env.local`, `.env` or the shell. It reads it from the
person or the pipe:

- on a terminal (stdin a TTY), it asks on stderr (`DATABASE_URL, the database's URL (not shown; Ctrl-C cancels):`)
  and reads one line with the terminal's echo off (raw mode), so nothing typed is shown or kept in a terminal's
  history; Ctrl-C, Ctrl-D or Enter on an empty line cancels before anything is sent, and the terminal is put back on
  every way out;
- otherwise it reads stdin whole, at most 2 KiB after one trailing newline (`\n` or `\r\n`) is trimmed, within 60 s:
  `mason replica create acme/shop --region <region> --size 50 < url.txt`, or piped from a secret store's command. An
  empty stdin, more than one line or more than 2 KiB is refused, sending nothing.

A command line that holds a URL (`://`, `postgres:`, or a `password=`), in any argument or flag, is refused before
anything else is read (exit 2), never repeated, with the line to run instead. The sources file gives the variable's
NAME alone (`url: ${DATABASE_URL}`), which is sent as `variable` and which the replica reads the URL by; a sources
file with a `url:` written in it is refused before anything is sent: the replica reads its database's URL from a
variable of its own environment, and a literal would be kept with the project's files. A value Mason could not
connect by is refused too, and never repeated. The URL is sent this once, for Mason's checks of the database from the
replica's side; a service never repeats it. The CLI holds its password as a secret of the command beside the token,
in the ONE list every boundary reads: the exact test of every value (an answer that carries it in a value held to a
grammar, or in a key, is refused whole), the masks of free text (a check's words, a refusal's, the system's words for
an answer that did not come), and the output's gate, which holds it before anything after the question is written.
Each compares it with a text by ONE READING of both (`readUnits` in src/cli/hosted.ts), so it is found whatever form
it is echoed in:

- its case (upper, lower, mixed; `ß` and `SS` alike);
- `%XX` escapes, of any or every byte, UTF-8 decoded;
- each Unicode normal form (NFC, NFD, NFKC, NFKD): a compatibility form (full-width letters, a ligature) as its letters;
- its accents dropped;
- a zero-width, format or control character, or a terminal escape, between its characters;
- another white space (a no-break space, a tab) for a space, or a run of spaces for one.

It is found WHOLE in that reading, and, when it has 8 or more letters, digits, `-` and `_`, by those runs too (11 in
a row, or all of them when fewer). What no reading reaches is outside this: a homoglyph from another script, its
characters reversed or spread with other characters between them, base64 or another encoding.

Two passwords are not sent, and the creation is refused before a byte is sent, naming neither the password nor its
length:

- one under 8 characters in that reading: nothing could tell it apart from ordinary words in what is printed;
- one the CLI's own words hold: its lines, its steps, the replica's name or the service's address. The output's gate
  would read it in an honest answer, after the replica was made. The rule reads every word a creation can print of its
  own, rendered by the builders it prints with (`printedCorpus`), as the gate reads them.

A password that only the service's own words and the CLI's together spell (`fix: set wal` across a check's fix) is
still read by the gate, and that answer is refused, its words never printed.

**The wait.** The service answers once it has run Mason's checks of the database, within the 60 s the CLI allows this
one request. A POST that gets no answer may have made the replica: the CLI then asks `GET
/v1/replicas/{org}/{name}` once, and goes on waiting when it is there (state `checking` while the checks run), or says
it was not made (`404`), or that it cannot tell. After `201` the CLI asks `GET /v1/replicas/{org}/{name}` every 5 s (or
after the seconds a `Retry-After` asks for) until the state is `ready` (exit 0) or `failed` (exit 1), and stops at
`--timeout` (default `15m`, `1s` to `24h`: exit 124, nothing stopped). A `429`, a `5xx` or no answer is a wait, a `404`
is a replica gone (`not_found`).

**An account's first replica is made in the service's web app**, where it asks whether a person is creating it, which
a command cannot answer. The API refuses it (`403`), and the CLI's next step says so, with the role that may create one;
the replicas after it can be made by the API.

`SourceChecks` is Mason's checks of the one source, as `mason doctor` runs them, scrubbed by the service of the
credential: `{ source, outcome: "passed" | "failed" | "unknown", checks: [{ name, status: "ok" | "warn" | "failed" |
"unknown", detail, fix? }], missing: [name] }`. A `warn` passes (a user that can write). `missing` names the checks
that did not run. The CLI says each check on a line of its own, in the service's words, and each of those words one
line (`serviceText`).

A creation that did not pass answers with the failure shape (below), plus `failure`, which the CLI does not read, and,
except when the service's own side failed, `checks`, which it says:

| Status | `error.code` | When |
|---|---|---|
| `400` | `bad_request` | a key, a type or a bound of the body; a name taken in the organisation; a region or a size the service does not offer; a `variable` other than `DATABASE_URL`; a CLI too old for this route |
| `400` | `bad_request` | the URL's host does not resolve, or resolves to a private, loopback, link-local or reserved address |
| `400` | `bad_request` | the URL's port is below 1024; the URL has no password or no database name; it has a query parameter other than `sslmode` |
| `403` | `refused` | a CI token; a viewer; an email not verified yet; the account's limit of replicas reached; an account that has not made its first replica in the web app |
| `404` | `not_found` | no such organisation, or the login is not a member: said the same way |
| `409` | `refused` | the token was revoked, or its role lowered, while the checks ran: nothing was made |
| `413` | `too_large` | past 64 KiB |
| `415` | `bad_request` | not `application/json` |
| `422` | `checks_failed` | Mason's checks of the database failed: fix what `checks` says (`mason doctor` runs the same checks here), and create it again |
| `429` | `slow_down` | too many replicas started this hour; `Retry-After` |
| `426` | any | a CLI too old for this route: the service's words say what to do (upgrade it) |
| `503` | `checks_unknown`, `unavailable` | Mason could not tell whether the database is ready; or the service's side could not run the checks, or could not start the replica's launch, just now; `Retry-After` |

The CLI's code follows the HTTP status, as for every `/v1/` failure; its next step is its own: `mason login` (as an
admin or an owner) for a `401` or `403`, `mason doctor` and the same `mason replica create` for a `422`, `mason replica
list <org>` for a `404`, else the same `mason replica create`. A `503` with `Retry-After` is said with the seconds the
service asks for (`the service asks for another try in 30 s`); the CLI does not wait for them, and exits 1.

### `Replica`

| Key | Held to |
|---|---|
| `org`, `name` | the organisation asked (and the name asked, for one replica); `^[a-z0-9][a-z0-9-]{0,62}$` |
| `region` | `^[a-z0-9][a-z0-9-]{0,62}$` |
| `sizeGb` | a whole number, 1 to 1,000,000 |
| `hostId` | the replica's own host id, `^[a-z0-9][a-z0-9-]{0,62}$` |
| `state` | `checking` (its checks run; nothing made yet), `creating` (its region makes it), `ready`, `failed` (its region did not make it, after every attempt: an admin tries again in the web app), `deleting` or `deleted` |
| `createdAt` | ISO 8601 with its zone |
| `allowlist` | the address ranges that may query it, each IPv4 or IPv6 with its prefix length; at most 1000 |
| `page` | optional: the replica's page in the service's web app, where its allowlist is set; an absolute URL on the service's own origin, with no user or password, tested as the URL parser prints it (one elsewhere refuses the answer). `mason replica create` prints it when the replica is ready, `status` beside its other facts |
| `pending` | what of its region's work is not done, at most 16: `[{ change: "create" \| "allowlist" \| "upgrade", state: "pending" \| "failed", attempts, failure?, nextAttemptAt? }]`, `failure` a sentence (said as one line), `nextAttemptAt` ISO 8601 |
| `mason` | optional: the Mason it runs, `{ version, latest, next }`. `version` is the Mason version the replica runs; `latest` the newest the service offers, never older than `version`; `next` a newer version already installed on the replica, which starts with the first deploy of a project pinned to its release line (newer than `version`, never newer than `latest`), or `null` (or absent) for none. Each version is `x.y.z` (digits, no `v`, nothing after). Absent or `null` for a service that does not say it: `mason replica status` then shows no version, and `mason deploy` leaves the pin to the replica. One present that does not hold refuses the answer whole. `status` shows it as a row, and names `mason replica upgrade` as a next step while the replica is `ready` and `latest` is newer than both `version` and `next` |
| `deletion` | in one replica's answer (`GET …/{name}`, a `DELETE`'s): [`Deletion`](#deletion), always while `state` is `deleted`, optional while it is `deleting` (absent or `null` for a replica deleted another way, as from the service's web app: the CLI then says it is being deleted and nothing more), and never in any other state. One present is held whole: a malformed one refuses the answer |

**A `pending` change a CLI does not know is held back.** A CLI refuses a replica's answer whose `pending[].change` is
outside the set it knows, so a service sends a change only to a CLI that knows it: it reads the CLI's version from
`User-Agent: mason-cli/<version>` (`dev`, a checkout's, and `main-<sha>`, the image built from main, are no release and count as current) and leaves out of `pending` an entry whose
change that version does not know, so an older CLI does not see it. `"upgrade"` is sent only to `mason-cli` 0.12.0 or
later.

`--json` prints each replica with these keys, `page`, `failure`, `nextAttemptAt` and `mason` `null` when absent; `status` and
`delete` print its deletion beside it, as `deletion` (`null` while it is in none, or when the service gave none).

**What is tested first.** Before any value is held to its grammar, every string of each answer, each key included, is
put to the exact test (`carriesNoSecret`: the token and the URL's password, and the shapes of a token or a password),
but the service's words alone: a check's `name`, `detail` and `fix`, `missing`, a pending change's `failure` — free
text, masked as a failure's words are. An answer that carries a secret anywhere else is refused whole, said by its
status. Any other answer outside these shapes is a failure naming the request and the status, never the body.

### `DELETE /v1/replicas/{org}/{name}`

`mason replica delete <org>/<name>` deletes a replica for good: it and its synced data go, and Mason's replication slot
on each database it syncs is dropped. `Content-Type: application/json`, at most 512 bytes, one level deep:

```json
{ "confirm": "acme/shop" }
```

`confirm` names the replica exactly, `{org}/{name}`: nothing trimmed or case-folded. The CLI sends the name on its
command line. At a terminal it first asks a person to type that name back, and sends nothing unless they typed exactly
it; it never prints what was typed. Without a terminal, and with `--json`, it needs `--yes`, and is refused as a wrong
line (exit 2) without it, before a byte is sent.

Who may: an owner of the organisation, signed in as a person with a login made within the last 15 minutes (a fresh
`mason login`). A CI token deletes none.

| Status | `error.code` | When |
|---|---|---|
| `202` | | under way: `{ replica }`, its `state` `deleting`, with its `deletion` (optional, as for any replica `deleting`). A repeat is answered the same, changing nothing |
| `200` | | deleted already: `{ replica }`, its `state` `deleted`, its deletion finished (the record the service keeps of it) |
| `400` | `bad_request` | the body is not `{ confirm }`, or `confirm` does not name `{org}/{name}` exactly; the value sent is never repeated |
| `401` | `unauthenticated` | no token, or one the service does not take |
| `403` | `refused` | a CI token, or a role below owner |
| `403` | `fresh_login_needed` | the login is more than 15 minutes old |
| `404` | `not_found` | no such organisation or replica for this token, said the same way |
| `409` | `refused` | the token was revoked, or its role lowered, while the request ran: nothing changed |
| `413` | `too_large` | past 512 bytes |
| `429` | `slow_down` | the account has made its deletions for the hour: nothing deleted; `Retry-After`. Never for a repeat |
| `503` | `unavailable` | the organisation's changes are queued; `Retry-After` |

The CLI's code follows the HTTP status, as for every `/v1/` failure, and its next step is its own: `mason login` "then
delete it within 15 minutes, or on its page in the service's web app" for `fresh_login_needed`; `mason login` as an
owner for any other `401` or `403`; `mason replica list <org>` for a `404`; for a `429` or a `503`, the same `mason
replica delete`, again after the time its `Retry-After` asks for (said as a time), or "later" when it asks none; else
the same `mason replica delete`.

**The wait.** After `202` the CLI asks `GET /v1/replicas/{org}/{name}` every 5 s (or after the seconds a `Retry-After`
asks for) until the deletion's `stage` is `finished` or `needs_person`, and stops at `--timeout` (default `15m`, `1s` to
`24h`: exit 124, nothing stopped; `mason replica status` says how it goes). A replica `deleting` with no `deletion` is
waited on the same way, said as being deleted. A `429`, a `5xx` or no answer is a wait. A `404` is a replica
gone, whose deletion's outcome is not known (`not_found`, with the statement that lists Mason's slots, below). A
replica that is in no deletion any more is an answer outside the contract. A `DELETE` that gets no answer may have
begun it: the CLI asks its state once, and waits when it is being deleted, or says that its deletion did not begin, or
that it cannot tell. It says each step once, as it is done, in the service's words, one line each.

**A person is needed while a slot is not verified gone.** A replication slot left on a database holds its WAL for as
long as it exists, so a service never deletes the replica, nor anything it needs to finish the deletion, while a
source's slot is `not_verified`: once it has done all it can, the deletion's `stage` is `needs_person`, the replica
stays `deleting`, and each such source carries its `slot` (and `publication`, `publicationOwned`) so a client renders
the statement to run by hand (below). The service goes on to `finished` once each such slot is seen gone, or a person
confirms in the service's web app that they dropped it by hand, or that its database is no more (that source's
`outcome` is then `confirmed`). How a person confirms is the service's own; this API only reports it.

**The outcome.** Exit 0 once the deletion is finished, every source's slot dropped, none there or confirmed. At
`needs_person` the CLI stops waiting at once (nothing more comes of waiting, whatever `--timeout`), prints each
source's outcome and what to run by hand, each statement alone on its line, then a failure (code `failed`, exit 1: the
replica is not deleted yet) whose fix is to run the statement, then confirm it on the replica's page in the service's
web app, and whose next step is `mason replica status <org>/<name>`. `--json` carries the same: `deletion.stage`
`needs_person`, each source's `byHand` the CLI's statement, and `error`. `mason replica status` shows a deletion under
way, needing a person, or finished, the same way, and exits 0.

### `Deletion`

| Key | Held to |
|---|---|
| `stage` | `requested` (asked for, not handed over to the replica's region yet: until then the addresses of its allowlist may still query it), `in_region` (under way: nobody may query it; its steps arrive), `needs_person` (all done that can be, but a source's slot is `not_verified`: at least one is, and the replica is kept until each is seen gone or confirmed) or `finished` (no source `not_verified`). A replica `deleting` is at `requested`, `in_region` or `needs_person`; one `deleted` at `finished` |
| `requestedAt` | ISO 8601 with its zone |
| `handover` | at `requested` alone, or absent: `{ attempts, failure?, nextAttemptAt? }`, `failure` a sentence (said as one line) |
| `lastHeardAt` | ISO 8601, or `null` |
| `finishedAt` | ISO 8601 once `stage` is `finished`, else `null` |
| `steps` | every step of the deletion, in order, at most 64: `[{ step, what, doneAt }]`. `step` is an id (lower case letters, digits and `_`, each once); `what` is the service's words for it (said as one line); `doneAt` ISO 8601, `null` until it is done. The CLI assumes no count and no id |
| `sources` | one per database the replica syncs, in order, at most 16: [`DeletionSource`](#deletionsource) |

### `DeletionSource`

| Key | Held to |
|---|---|
| `ordinal` | its place in `sources`, from 0 |
| `outcome` | what the deletion did to Mason's replication slot on that database: `dropped` (and verified gone), `no_slot` (none there: nothing to drop), `not_verified`, or `confirmed` (not seen gone by the service: a person confirmed they dropped it by hand, or that its database is no more) |
| `reason` | `not_verified` alone: `unreachable`, `refused`, `in_use`, `still_there`, `another_server`, `record_unreadable`, `failed` or `unprobed`, said in the CLI's words |
| `why` | `not_verified` alone, optional: the service's words (said as one line) |
| `slot` | the slot's name, or `null` when it is not known; `dropped` names it, and `not_verified` should, so the statement by hand drops it rather than lists the slots. Postgres's name grammar: `^[a-z0-9_]{1,63}$` |
| `publication` | the publication's name, or `null`; the same grammar |
| `publicationOwned` | absent for `no_slot`; else (`dropped`, `not_verified`, `confirmed`) `true` (the publication is Mason's own, named `mason_…`), `false` (the database owner's) or `null` (not said) |
| `byHand` | optional, advisory: the service's own statement to run by hand. A string; a client renders its own from the names (below), and the CLI never prints this one nor compares it |
| `reportedAt` | ISO 8601 |

**What to run by hand is the CLI's own.** Mason is the one authority for the SQL that drops or lists its own slots. For a
slot not verified gone the CLI prints the statement Mason itself gives for dropping its slot (`dropStatements` in
src/cli/replication-mode.ts, which `mason start` and `mason destroy` print too), rendered from the names the service
sent, each held to the grammar first: an answer with a name outside it is refused whole. A service's `byHand` is
advisory: the CLI reads it only as a string that carries no secret, and never prints it, compares it or depends on its
text, so any client renders its own from `slot`, `publication` and `publicationOwned`. For a slot named `<slot>`:

```sql
SELECT pg_drop_replication_slot('<slot>') FROM pg_replication_slots WHERE slot_name = '<slot>' AND NOT active;
```

followed, only when `publicationOwned` is `true`, by a space and `DROP PUBLICATION IF EXISTS <publication>;`. For a slot
whose name is not known (`slot` `null`), the statement that lists Mason's slots on the database, to find it:

```sql
SELECT slot_name, database, active FROM pg_replication_slots WHERE left(slot_name, 6) = 'mason_';
```

The CLI prints each statement alone on a line of its own, indented, never broken at the terminal's width (a break
inside a name would be pasted with it), after a line saying which source it is for; under `--json` it is
`deletion.sources[].byHand`, the CLI's rendering. The same holds wherever the CLI prints a statement: a replica gone
midway prints the statement that lists Mason's slots that way too, never inside a failure's words.

**What is tested first.** As for every replica's answer, every string of it, each key included, is put to the exact
test before any value is held to its grammar, but the service's words alone: a step's `what`, a source's `why`, the
handover's `failure`, which are masked. A step's id, a slot's or a publication's name and `byHand` are no free text: an
answer that carries a secret in one is refused whole.

### `POST /v1/replicas/{org}/{name}/upgrade`

`mason replica upgrade <org>/<name>` asks the service to move a replica to the newest Mason it offers (`Replica`'s
`mason.latest`). Within the replica's release line it then runs that version (`mason.version`); a newer release line is
installed beside the one it runs (`mason.next`), and starts with the first deploy of a project pinned to that line, so a
project written for the line it runs goes on running. Either way Mason on the replica restarts, and every connection to
it drops. `Content-Type: application/json`, at most 512 bytes:

```json
{ "client": { "version": "0.9.0" } }
```

`client.version` is the CLI's version (`dev` from a checkout), as a creation and a deploy send it. At a terminal the CLI
first says what happens (a restart; connections drop) and asks a person to type `{org}/{name}` back, as `mason replica
delete` does, and sends nothing unless they typed exactly it; without a terminal, and with `--json`, it needs `--yes`,
and is refused as a wrong line (exit 2) without it, before a byte is sent.

Who may: an owner of the organisation. A CI token upgrades none.

| Status | `error.code` | When |
|---|---|---|
| `202` | | under way: `{ replica }`, carrying the pending change `"upgrade"` (state `pending`). A repeat while it is under way is answered the same, changing nothing |
| `200` | | nothing to do: the replica has the newest Mason the service offers already. `{ replica }`, carrying no pending `"upgrade"` |
| `400` | `bad_request` | the body cannot be read |
| `401` | `unauthenticated` | no token, or one the service does not take |
| `403` | `refused` | a CI token, or a role below owner |
| `404` | `not_found` | no such organisation or replica for this token, said the same way |
| `409` | `refused` | the replica is not `ready` (`checking`, `creating`, `failed`, `deleting`, `deleted`), or the token was revoked meanwhile |
| `409` | `busy` | another change of the replica is under way (a deploy, its allowlist) |
| `413` | `too_large` | past 512 bytes |
| `426` | any | a CLI too old for this route: the service's words say what to do |
| `429` | `slow_down` | too many upgrades asked for; `Retry-After` |
| `503` | `unavailable` | the service cannot take it just now; `Retry-After` |

The CLI's code follows the HTTP status, as for every `/v1/` failure, and its next step is its own: `mason login` as an
owner for a `401` or `403`; `mason replica list <org>` for a `404`; `mason replica status <org>/<name>` for a `409`;
for a `429` or a `503`, the same `mason replica upgrade`, again after the time its `Retry-After` asks for, or "later";
else the same `mason replica upgrade`. A `202` that carries no pending `"upgrade"` under way, or a `200` that carries
one, is an answer outside the contract. An `upgrade` POST that gets no answer is not sent again: the CLI says whether
it began is not known, and `mason replica status` says it.

**The wait.** After `202` the CLI asks `GET /v1/replicas/{org}/{name}` every 5 s (or after the seconds a `Retry-After`
asks for) until the replica carries no pending `"upgrade"` and is `ready` (exit 0, saying the Mason it runs, or the one
installed and what starts it), and stops at `--timeout` (default `15m`, `1s` to `24h`: exit 124, nothing stopped). A
pending `"upgrade"` whose state is `failed` is a failure (code `failed`, exit 1, its `failure` in `why`); a replica that
turns `failed`, `deleting` or `deleted` is one too; a `404` is a replica gone (`not_found`). A `429`, a `5xx` or no
answer is a wait. `--json` prints `{ replica, already, next }` (`already` `true` for a `200`), with `error` on a failure.

## CI tokens: `mason token`

`mason token create | list | revoke` makes, lists and revokes an organisation's CI tokens. A CI token acts on ONE
replica, for named scopes (`deploy`: `mason deploy`; `users`: `mason user … --replica`), until it expires. Each request
takes a login of an admin or an owner of the organisation (a CI token makes, lists and revokes none: `403`).

| Subcommand | Request | `200` / `201` |
|---|---|---|
| `create --replica <org>/<name>` | `POST /v1/tokens/{org}` | `201 { token: CiToken & { value } }` |
| `list [<org>]` | `GET /v1/tokens/{org}` | `{ tokens: [CiToken], more }` |
| `revoke <id> [--org <org>]` | `POST /v1/tokens/{org}/{id}/revoke`, no body | `{ revoked: { id, name } }` |

`list` with no `<org>` asks `GET /v1/me`, then each organisation the login is an admin or an owner of; `revoke` with no
`--org` takes the one such organisation, and asks which when there are several (exit 2).

`POST`'s body, `application/json`: `{ "name": "github-actions", "replica": "shop", "scopes": ["deploy"],
"expiresInDays": 90 }`.

- `name` is 1 to 64 characters, with no control character (`--name`, default `ci`).
- `replica` is the name of one of the organisation's replicas (`--replica <org>/<name>`, else `MASON_REPLICA`).
- `scopes` holds each of `deploy` and `users` at most once (`--scope`, repeated; default `deploy`).
- `expiresInDays` is a whole number, 1 to 365 (`--days`, default 90).
- Any other key is refused. The CLI refuses a line outside these before it sends anything (exit 2).

`CiToken` is `{ id, name, replica: "{org}/{name}", scopes, madeBy?, createdAt, lastUsedAt?, expiresAt }`:

| Key | Held to |
|---|---|
| `id` | `^[A-Za-z0-9_-]{1,64}$`, so it is safe in the revoke's path; revoke's answer, the id asked |
| `name`, `madeBy` | a string, said as one line (`madeBy` an email, absent or `null` in create's answer) |
| `replica` | `<org>/<name>` of the organisation asked; create's, the replica asked |
| `scopes` | each of `deploy` and `users`, once; create's, those asked |
| `createdAt`, `expiresAt`, `lastUsedAt` | ISO 8601 with its zone (`lastUsedAt` `null` when never used) |

**`value` is the token itself**: `masondata_ci_` and 43 base64url characters. The service answers it once, by the POST
that made it (`Cache-Control: no-store`), and never again: not by the list nor by any other request. So the CLI prints
it ONCE, alone on the first line it prints (never broken by the CLI: a terminal narrower than it wraps it, which a
copy joins), or with `--json` in the one field `token.value` (so a CI setup step can pipe it into a secret store), and
nowhere else:

- the value is held to that form, and is not the login's own token nor an echo of it;
- every other string of the answer, each key included, is put to the exact test against the login AND the value, so an
  answer that carries the value a second time (in its name, its id, a key), or the login, is refused whole, and nothing
  of it is printed: the CLI says a token may have been made all the same, and `mason token list` says which act;
- the output's gate (src/cli/output-gate.ts) lets that one value through once, exactly as it is, and holds it as a
  secret beside the login from the start: a second copy, 11 of its body in a row elsewhere, or anything else shaped as
  a token, is refused at the write.

Refusals: `400` a key, type or bound; `403` a CI token or a viewer; `404` no such organisation or not a member, no such
replica in it (POST), or no live CI token by that id (revoke: revoked already, expired, or another organisation's);
`409` revoked or demoted meanwhile, or (POST) the replica being deleted; `413` past 4 KiB, or any body sent to the
revoke; `429` too many tokens made this hour. Each is said as "Failures of `/v1/`" says; the CLI's next step is its
own: `mason login` (as an admin or an owner) for a `401` or `403`, `mason token list <org>` for a revoke's `404`,
`mason replica list <org>` for a create's.

## Deploying a project: `mason deploy`

A deploy sends a project's files to one replica and waits until Mason on the replica runs them, or refuses them. The
replica is named `{org}/{name}`: each part matches `^[a-z0-9][a-z0-9-]{0,62}$` (the CLI refuses any other before it
sends a byte, so a name is always safe in a path). Both requests carry `Authorization: Bearer <token>`.

### What the CLI checks before it sends anything

The project is checked on this machine by Mason's own readers, as `mason start` checks it before it connects: the
`mason.yml` pin, the sources file, the roles file against the tables the sources file names, and the generated
tables (a refused one is said, and does not stop the deploy, as it does not stop a start).

**What the replica runs.** Once signed in, the CLI asks `GET /v1/replicas/{org}/{name}?project=1` (below, "What the
deploy changes"), once, before anything is sent.

**The replica's Mason.** When the project has a pin and the answer is `200` and carries `Replica`'s `mason`, a project the replica would not run is refused before
anything is sent: its pin must fit `mason.version` or `mason.next`, by the image's own rule (the same release line, at
that version or later than the pin). The refusal (code `refused`, exit 1) names the pin and both versions, and the ways
out: write the project for the replica's Mason (`npx @mason-data/cli@<version>` is its mason command), or `mason
replica upgrade <org>/<name>` when `mason.latest` would run it. Everything else cannot tell, and the deploy is sent as
before, the check left to the replica, whose image refuses such a project itself: a `200` without `mason` (a service
that does not say it), a `200` this CLI cannot read (outside `Replica` as it knows it: a `pending` change it does not
know, a `mason` it does not take, another replica's name, not JSON), any other status, and no answer. One exception: a
`200` that carries the token or the shape of one, in any value (a file of the replica's project included) or in the
service's words, is refused whole (code `failed`, exit 1, nothing sent), as every answer is. `mason replica status` and `mason replica upgrade` hold the same
answer strictly: there an answer outside the contract is refused. A project with no `mason.yml` is not checked, as the
image runs it. No database is connected
to. A project a start would refuse is refused here, in the CLI's failure shape, and nothing is sent. A sources file
whose `url:` is written with its password is refused too: the replica keeps the files it runs, and a secret is never one of
them (`url: ${DATABASE_URL}`, with `DATABASE_URL` set on the replica, is the way).

The files are the project folder's project files, the one list `mason start` fingerprints (`src/lib/project-files.ts`):
every `.yml` and `.yaml` under the folder (`mason/`), outside any folder or file whose name starts with `.` and outside
`node_modules`. Never `.env`, `.mason/`, a dotfile or a file of another kind.

- `path` is relative to the project folder, its parts joined by `/` (`sources/app.yml`, `mason.yml`,
  `generated_tables/daily.yml`). Each part matches `^[A-Za-z0-9_][A-Za-z0-9._-]*$`, and the path is at most 255
  characters.
- Each file is a regular file inside the project folder; a symbolic link that leaves the folder is refused. Every file
  the check above read is among those sent.
- `content` is the file's text: its bytes, which must be valid UTF-8 (a file that is not is refused). `sha256` is the
  SHA-256 of those bytes, as 64 lower-case hex digits.
- At most 256 KiB (262,144 bytes) a file, 1 MiB (1,048,576 bytes) all the files' bytes together, and 500 files. The
  CLI refuses past any of them, naming the file or the sizes.
- `mason deploy --dry-run` prints each path, its size and its sha256, and sends nothing (it needs no login for
  that; signed in, it also asks what the replica runs, and prints what the deploy changes there).

### What the deploy changes

Before it sends, the CLI shows what the deploy changes on the replica, worked out against what the replica runs now:
the tables it adds (each a first sync, with its size where the service says it), the tables it removes (their synced
data dropped), the tables whose columns, key or `sync:` change, the generated tables and roles it adds, removes or
changes, the default role, and the pin. `mason deploy --dry-run` prints it too, when a replica is named and the
machine is signed in; `--json` carries it as `plan` (`null`, with `planUnknown` saying why, when it cannot be shown).

**The question.** The service says what the replica runs in the answer to `GET /v1/replicas/{org}/{name}?project=1`:
beside `replica`, an optional `project`.

```json
{ "replica": { … }, "project": {
  "files": [{ "path": "sources/app.yml", "sha256": "2aab…", "content": "kind: postgres\n…" }],
  "tables": [{ "table": "public.orders", "rows": 1200000, "bytes": 734003200 }] } }
```

| Key | Held to |
|---|---|
| `files` | the project the replica runs now, whichever way it got there (a deploy, or the service's own web app), as a deploy sends files: each `path` in the deploy's grammar and once, `sha256` the SHA-256 of `content`'s UTF-8 bytes (checked), within the deploy's bounds (256 KiB a file, 1 MiB in all, 500 files). A replica that runs no project yet answers `[]` |
| `tables` | at most 10,000 sizes, each `{ table, rows, bytes }`: `table` as the sources file names it in full (`schema.table`, at most 300 characters); `rows` and `bytes` whole numbers of 0 or more, or `null` where not known. For a table the replica syncs, its synced data's; the service may add others of the source's tables (an estimate, as `mason tables` gives one), so a deploy that adds one can say its size. A table missing from the list is said as "size not known" |

- The `?project=1` query asks for `project`; without it (`mason replica status`) the answer is as before. Older
  services ignore the query.
- `project` absent or `null`: the service does not say (an older one, or one that cannot ask the replica just now).
  The CLI then says the plan cannot be shown, and why, and the deploy goes on as before. It never guesses a plan.
- A `project` outside the shape above (a path outside the grammar, a `sha256` that is not its content's, past a
  bound, a size that is no count), or a file of it Mason's readers cannot read: the same, the plan unknown, said with
  why.
- Every string of it is put to the exact test first, as every answer's is; one that carries the token is refused
  whole, nothing sent. Every name the CLI prints from it is one line, bounded and masked, as every value of a
  service's is.

**Removing a synced table is confirmed.** A removed table's synced data is dropped, and syncing it again is a new
first sync, reading every row from the source, so a deploy whose plan removes one or more tables of what the replica runs now is confirmed
before it is sent. The CLI names each table with its size (or "size not known"):

- at a terminal, it asks for the replica's name (`<org>/<name>`) to be typed back exactly; anything else sends
  nothing (code `refused`, exit 1);
- without a terminal, and with `--json`, it is refused (code `refused`, exit 1, nothing sent), naming the tables and
  their sizes, its way out `mason deploy --replica <org>/<name> --yes`;
- `--yes` goes ahead without asking.

Adding a table is never asked about: it costs a first sync, not synced data. A deploy that removes no table goes ahead
without asking. When the plan cannot be shown, nothing is asked: the replica's own check below is the guard.

**The service refuses a removal not confirmed.** So that an older CLI, or a direct call to this API, cannot skip the
question, the deploy carries the tables whose removal was confirmed (`confirmed.removed`, below), and a service holds
the deploy to it before the replica takes the files. Mason itself makes no such check: it runs the files it is given.
What the service compares:

- the tables the sources file of the project the replica runs now names (each entry's table, `schema.table`; a bare
  name is in `public`), against those the deploy's sources file names;
- each table the first names and the second does not is removed, and must be in `confirmed.removed`;
- a deploy that removes one it lacks is `refused`, the replica left running what it ran before and its synced data
  kept, with the failure code `unconfirmed_removal`, its `message` naming each such table and its size;
- where the service cannot tell (it cannot read either sources file, or cannot reach what the replica runs), it fails
  closed: it refuses the same way, its `message` saying it could not tell.

The CLI prints the failure's words as they came (code `refused`, exit 1, `(the service said unconfirmed_removal)` at
the end of `why`) and gives its own way out: run `mason deploy --replica <org>/<name>` again, which shows the plan and
asks (or `--yes`). This also catches a plan gone stale: the replica's tables changed between the question and the
deploy.

### What the database must serve

The CLI never holds the database's URL (the replica's environment does), so what the files ask of the database can
only be checked on the replica. Mason's image gives a service the check to do it with, below: run before the deploy's
files are written, its refusal changes nothing — no file written, no sync started, no table dropped, the replica left
running what it ran before — and a service that runs it marks the deploy `refused` (below) with its words, which name
every problem at once, each with its fix, as `mason start` would say it:

- a table the sources file names that the database lacks, or that the replica's user cannot read: no `SELECT`, no
  `USAGE` on its schema, or row-level security with no policy for that user (every row hidden);
- a column or `key:` the table lacks, a table with no primary key, a replica identity that cannot be replicated;
- for the tables whose `sync:` is `replication`: `wal_level` not `logical`, a user that may not replicate (no
  `REPLICATION`, or the provider's role), no free replication slot or WAL sender, a read replica before Postgres 16,
  and the publication the file names missing, or not carrying a table (the fix names its statement, e.g. `ALTER
  PUBLICATION mason ADD TABLE public.orders;`, which the database's owner runs: Mason never alters it);
- the roles file naming a column a synced table lacks;
- the database not reachable with the replica's URL: the connection's own failure, never a deploy applied blind.

Mason's image answers this as `mason serve --check` (its usage has the details), run with the replica's environment
and `MASON_PROJECT` naming the deploy's files: read-only on the database, writing nothing, and never opening the synced
data, so it runs beside the replica's running Mason. Its `--json` answer carries the problems as data:

```json
{ "error": { "code": "refused", "message": "the database cannot serve this project as its files say: 1 problem", "why": "…", "fix": "…" },
  "problems": [{ "code": "publication", "table": "public.orders", "message": "publication mason: missing: public.orders",
    "fix": "the database's owner runs ALTER PUBLICATION mason ADD TABLE public.orders (id, status); …",
    "sql": "ALTER PUBLICATION mason ADD TABLE public.orders (id, status);" }], "next": [ … ] }
```

`code` is one of `unreachable`, `version`, `missing_table`, `table`, `replication`, `publication`, `roles`; `table`
(`schema.table`) and `sql` are `null` where there is none; exit 0 when the database can serve the project, 1 when not.
A service runs it in a deploy's `checking` phase and passes its words on as the deploy's `failure`; whether it does is
the service's, and a service that does not leaves the replica's start to refuse such a project, after its files are
written. The CLI prints the failure's words as they came, as for any refused deploy.

### `POST /v1/replicas/{org}/{name}/deploys`

`Content-Type: application/json`:

```json
{ "files": [{ "path": "sources/app.yml", "sha256": "2aab…", "content": "kind: postgres\n…" }], "client": { "version": "0.7.0" } }
```

- `files` is the whole project, sorted by `path`, each path once. The replica's project becomes exactly these files: a
  file the replica had and the list lacks is removed. A deploy never merges.
- `client.version` is the CLI's version (`dev` from a checkout).
- `confirmed` is optional, `{ "removed": ["billing.invoices", "public.items"] }`: the tables (`schema.table`, as the
  plan named them) whose removal a person confirmed, or `--yes` did. The CLI sends it only when its plan removes a
  table. A service refuses a deploy that removes a table this list lacks ("What the deploy changes", above); a
  service that does not know the key ignores it.
- The service checks the bounds above, each `sha256` against its `content`, and the path grammar: past a bound is
  `413 too_large`, a `sha256` or a path that does not hold `422 invalid` (the table below). It may refuse a body over
  8 MiB with `413` before reading it.

`201`:

```json
{ "deploy": { "id": "dep_01HZX…", "status": "queued", "createdAt": "2026-11-02T10:00:00Z" } }
```

`id` matches `^[A-Za-z0-9_-]{1,64}$`, held to it before the CLI puts it in the next path (an id outside it, which could
point the next request at another path, is a failure); `status` is `queued`. Other statuses, each with the failure
shape, are said as "Failures of `/v1/`" says: their words as the service wrote them, each one line, the CLI's code
from the HTTP status (`404` `not_found`, the others `refused`), exit 1, the service's code at the end of `why`, and the
CLI's own next step (`next` is never read), but for a `503` and a `429`, which are waited on (below):

| Status | The service's `code` | When |
|---|---|---|
| `401` | `unauthenticated` | no token, or one the service does not take (the CLI's next step: `mason login`) |
| `403` | `refused` | the token may not deploy this replica (a viewer's, or a CI token made for another replica) |
| `404` | `not_found` | no such replica in that organisation (a deleted replica's included: its name is freed), or the token's account is not in the organisation: said the same way, so it never tells whether the name exists elsewhere (the CLI's next step: `mason replica list <org>`) |
| `409` | `busy` | another deploy to this replica has not finished; `why` names its id |
| `409` | `not_ready` | the replica cannot take a deploy: it failed, or is being deleted. The body carries its state beside the failure, `"replica": { "state": "failed" \| "deleting" }` (as `Replica`'s `state`). The CLI says the state in its own words at the start of `why`, and its next step is `mason replica status <org>/<name>`; it never sends the deploy again |
| `413` | `too_large` | past a bound above; `why` names the file or the sizes |
| `422` | `invalid` | the service's own check of the files: `message` names the file and what is wrong, `why` the rest |

Two answers say the service made NO deploy and asks the CLI to send it again later. Each carries `Retry-After`
(delta-seconds), and may carry the failure shape:

| Status | When | The CLI |
|---|---|---|
| `503` | the replica is being made — `"replica": { "state": "checking" \| "creating" }` — or it is `ready` and the machine it runs on is not connected to the service just now (`"state": "ready"`); or the service cannot take a deploy just now (no `replica`) | waits, then sends the same POST again |
| `429` | too many deploys are being sent at once | waits, then sends the same POST again |

- The CLI waits the seconds `Retry-After` asks (1 to 3600), or 5 s when it sends none or one in another form, never
  past what is left of `--timeout`. While it waits, a person sees what it waits on (the replica's state, in the CLI's
  words, when the answer gives one) and how long it has waited, on stderr; `--json` prints nothing until the answer.
- Nothing else of these answers is printed: the failure's words are not shown. Every string of the body but those words,
  each key included, is put to the exact test first, as every answer's is, and one that carries the token is refused
  whole.
- When `--timeout` runs out first, the CLI exits 124 (code `timeout`), saying no deploy was made and what it waited on;
  its next steps are `mason replica status <org>/<name>` and `mason deploy --replica <org>/<name>`.
- A POST is sent again only on these two answers, which say no deploy was made. Any other answer, and no answer at all,
  is never retried: a deploy that may have been made would be made twice.

When no answer comes back to the POST, whether the deploy was made is not known: the CLI says so, and the next
`mason deploy` is answered `409 busy` if it was.

### `GET /v1/replicas/{org}/{name}/deploys/{id}`

`200`:

```json
{ "deploy": { "id": "dep_01HZX…", "status": "applying", "phase": "checking", "createdAt": "2026-11-02T10:00:00Z" } }
```

| Key | |
|---|---|
| `id` | the id the POST answered |
| `status` | `queued`, `applying`, `starting`, `running`, `refused` or `failed` (below) |
| `phase` | optional: what is under way within the status, one of a closed set (below); absent or `null` for none |
| `failure` | present when, and only when, `status` is `refused` or `failed`: `{ code, message, why?, fix? }`, the failure shape's `error` (a `next` beside them is never read) |
| `createdAt` | when the POST was taken: ISO 8601 with its zone |
| `finishedAt` | when it reached `running`, `refused` or `failed`: ISO 8601 with its zone; absent before |

| `status` | Meaning | The CLI |
|---|---|---|
| `queued` | taken, waiting for its turn | waits |
| `applying` | Mason on the replica checks the files and takes them | waits |
| `starting` | Mason on the replica starts on the new files, until it serves | waits |
| `running` | the replica runs these files: Mason there serves from them | exit 0 |
| `refused` | Mason on the replica refused the files (a sources file naming a table the database lacks, a database that cannot serve them: "What the database must serve", a pin of another release line), or the service did (a table removed whose removal was not confirmed: `unconfirmed_removal`, above): `failure` is the refusal. The replica runs what it ran before | prints `failure`'s words as they came, code `refused`, exit 1 (for `unconfirmed_removal`, its way out the CLI's own: deploy again, to be asked) |
| `failed` | the deploy could not finish for a reason that is not the files' (the machine, the service): `failure` says what happened and what the replica runs now | prints `failure`'s words as they came, code `failed`, exit 1 |

| `phase` | With `status` | The CLI says |
|---|---|---|
| `checking` | `applying` | Mason on the replica checks the files |
| `writing` | `applying` | the files are written on the replica |
| `restarting` | `starting` | Mason on the replica restarts on them |
| `syncing` | `starting` | the tables the files add have their first sync |

A `status` or a `phase` outside these (or a phase beside another status) is outside the contract. The CLI says each in
its own words and never prints the service's text for it.

As for every `/v1/` failure, nothing in a deploy's `failure` decides what the CLI does, and none of it is structure:

- its `message`, `why` and `fix` are said as written, each as ONE line (every line break, control, zero-width, format
  or bidi character replaced by `?`, bounded, a token masked), so none starts a line, a row or a `Next:` block;
- its code is the CLI's, `refused` for a refused deploy and `failed` for a failed one, exit 1, never `usage` (2) or
  `timeout` (124), whatever `failure.code` says, which is kept at the end of `why` (`(Mason on the replica said
  bad_source)`);
- a `next` in it is never read: the next step is the CLI's own, `mason deploy --replica <org>/<name>` ("deploy again,
  once what it says is fixed").

Every other value of these answers the CLI prints is held before it is: the `id` to its grammar, `status` and `phase`
to their closed sets (said in the CLI's words), `createdAt` and `finishedAt` to ISO 8601 (`--json` alone). `--json`
never carries a line break in any string.

The CLI asks every 2 s, or after the seconds a `Retry-After` header (delta-seconds, 1 to 3600) asks for, on any
answer. A `429`, a `5xx` or no answer at all cannot say how the deploy goes: the CLI asks again, until its
`--timeout` (default `10m`, `1s` to `24h`). At the timeout it exits 124 and says the deploy may still finish, with its
id; that exit is the CLI's own clock's, never the service's word. A `401`, `403` or `404` with the failure shape is said
as "Failures of `/v1/`" says (`refused`, `refused`, `not_found`), exit 1.

Every other answer to either request (another status, a body that is not JSON or not this shape, an id other than the
one asked for, a status or phase outside the closed sets, a `failure` beside another status) is a failure naming the
request and the status, never the body, exit 1.

## The users of a replica: `mason user … --replica`

`mason user add | list | from | disable | enable | remove … --replica <org>/<name>` (else `MASON_REPLICA`) manages the users of
a replica's Postgres API, as `mason user` manages a project's own. Each subcommand is ONE request, and its body and its
answer are what Mason's own command server takes and answers for it (`/api/users` of a running Mason): a service passes
the request to Mason on the replica and its answer back unchanged, so Mason there checks the names, the role, the
attributes and the address ranges with the functions it checks them with on a laptop. Every request carries `Authorization: Bearer <token>`.
The replica's name is checked as for a deploy (each part `^[a-z0-9][a-z0-9-]{0,62}$`), and a user's name is
`^[a-z0-9][a-z0-9_.-]{0,62}$`, checked before it is put in a path, so both are always safe there unescaped.

What only the command line says is checked by the CLI first, and refused as a wrong line (exit 2) with nothing sent: a
subcommand, a user's name, a role's name (`^[a-z0-9][a-z0-9_-]{0,62}$`), a `--set` that is not `<attribute>=<value>`,
`--role`, `--set` or `--from` beside a subcommand other than `add`, an address range that is not one (an IPv4 or IPv6
address, alone or with a prefix length its family takes, no bits set past it: `999.999.999.999/99` and `10.0.1.5/24`
are refused), and `from` with neither ranges nor `--any`, or with both. Nothing of a project on this machine is read or written.

| Subcommand | Request | Body | `200` |
|---|---|---|---|
| `list` | `GET /v1/replicas/{org}/{name}/users?lastUsed=1` | none | `{ users, lastUsedNote, urlNote, requestLogDays }` |
| `add <user>` | `POST /v1/replicas/{org}/{name}/users` | `{ "name", "role"?, "set"?, "from"? }` | the user added (below) |
| `from <user> <range>… \| --any` | `POST /v1/replicas/{org}/{name}/users/{user}/from` | `{ "from" }` | `{ changed: { name, id, addedAt, from }, already }` |
| `disable <user>` | `POST /v1/replicas/{org}/{name}/users/{user}/disable` | none | `{ disabled: { name, id, addedAt, disabledAt }, already }` |
| `enable <user>` | `POST /v1/replicas/{org}/{name}/users/{user}/enable` | none | `{ enabled: { name, id, addedAt }, already }` |
| `remove <user>` | `DELETE /v1/replicas/{org}/{name}/users/{user}` | none | `{ removed: { name, id, addedAt, removedAt } }` |

- `add`'s body is `{ "name": "metabase" }`, with `"role": "<role>"` for `--role`, `"set": ["tenant=42", …]` for each
  `--set`, in the order given, as they were written, and `"from": ["203.0.113.0/24", …]` for each `--from`, in the order
  given, each in its one form (the network in lower case, IPv6 shortened, no prefix for one address: `192.0.2.10`).
- A user's ADDRESS RANGES are where it may connect from: a connection from any other address is refused before its
  password is checked. `from`'s body replaces them: `{ "from": [ranges…] }`, each in its one form, or `{ "from": null }`
  for `--any` (any address: its ranges removed). In every answer a user's `from` is `null` (any address) or 1 to 100
  ranges, each in its one form; a list's row with no `from` key is read as `null`.
- **A limit sent must be confirmed.** When `add` sends `from`, or `from` sends a list or `null`, the `200` answer must
  carry exactly what was sent, in its one form and order (`add`'s `from`, `from`'s `changed.from`). An answer without
  it, with `null`, or with other ranges is refused whole and never printed (an `add`'s password included): the CLI says
  the service did not confirm the address limit, exit 1, and its next steps are `mason user list --replica …` (what the
  user has) and `mason user remove <user> --replica …` (if it was made without the limit). A service that does not take
  `from` refuses it with a `400` naming the field, never ignores it: ignoring it would make a user that connects from
  any address while the CLI reported a limit.
- **A limit a service cannot enforce is a `400`**, its reason in the service's words (too many ranges, a family it
  does not take, a range wider than it allows, such as a `/0`), which the CLI says as it came, nothing written. For such
  a service, `from: null` (any address) means the user is limited by nothing beyond what the replica itself allows to
  connect.
- **The address judged is the client's.** Mason judges a user's ranges on the address the connection comes from; behind
  a load balancer or proxy that is the proxy's own, unless the proxy sends the PROXY protocol v2 header and Mason is
  told to believe it from the proxy's addresses (`MASON_PG_PROXY_FROM`, docs/POSTGRES-API.md "Behind a TCP proxy"). A
  service that puts a proxy in front of a replica's Postgres API passes the client's address through that way, or a
  user's ranges would be judged against the proxy's address.
- `already` is `true` when nothing changed (disabled already; not disabled): exit 0, said.
- A key beside those of the answer (a `next` included) is never read.

Each answer is held to the shape `mason user … --json` prints, before anything of it is printed, and every value is
held to its own grammar:

| Value | Held to |
|---|---|
| `name`, `user` | a user's name; for `add`, `disable`, `enable` and `remove`, the name asked |
| `id` | 16 lower-case hex digits |
| `addedAt`, `removedAt`, `disabledAt`, `lastUsedAt` | ISO 8601 with its zone (`null` where the list says none) |
| `password` (`add`) | `mason_<its id>_<32 lower-case hex digits>`: printed once, by `add`, in the `url`, `psql` and `password` rows |
| `database`, `host`, `port`, `sslmode` (`add`) | a database name Mason takes (at most 63 bytes, printable); a host name or an IP address; 1 to 65535; `require` or `disable` |
| `url`, `psql` (`add`) | exactly the URL and the psql line the CLI builds from `user`, `password`, `host`, `port`, `database` and `sslmode`: `postgres://<user>:<password>@<host>:<port>/<database>[?sslmode=require]`, `psql '<url>'` |
| `url` (`list`) | `null`, or `postgres://<its name>@<host>:<port>/<database>[?sslmode=require]`, with no password |
| `role`, `roleFrom`, `readsNothing`, `roleKnown` | a role's name; `file`, `default` or `none` (a role for the first two, none for `none`); `true` or absent (only with `none`); a boolean or absent (only with `file`) |
| `from` | `null`, or 1 to 100 address ranges, each in its one form (absent on `add`: any address) |
| `attributes`, `missingAttributes` | at most 64 attribute names (`^[a-z_][a-z0-9_]{0,62}$`), each a value or a list of 1 to 100; the names alone |
| `live`, `already` | booleans |
| `lastUsedNote`, `urlNote` | `null` or a string, said as one line |
| `requestLogDays` | `null` or a whole number, 1 to 36500 |
| `users` | at most 2000 |

An `add` answers with where the replica's Postgres API listens (`url`, `psql`, `host`, `port`, `sslmode`): Mason
there runs. Before any value is held to its grammar, EVERY string of the answer, each key included (an attribute's
name is printed), is tested for a secret, one string at a time:

- the token the CLI holds, whole, or 11 or more characters of its body in a row in that one string, read in any
  case, percent-decoded, in its compatibility form, and with or without `-` and `_` (so split by them, by a dot or
  a space, it is still read as one run);
- anything shaped as a token or a password (add's own `password`, `url` and `psql` are tested for the token alone).

An answer that carries one anywhere, even in a key the CLI does not read, is refused whole, and nothing of it is
printed: a grammar such as a user's name, a role's or a host's can spell a token's body or another user's password,
and is no mask. A failure's `code`, printed inside `why`, is tested the same way. The notes and a refusal's words are
also masked as every service text is ("Every request", above).

Why 11: an honest answer, which knows nothing of the token, is refused with a probability under 1 in a million at
the largest answer read (1 MiB): at most W × 43 × 2 × 31^-n for a run of n over W characters read, about 10^-7 at
worst and 3 × 10^-9 for 2000 users of random ids; at 10 the worst would be 4 × 10^-6.

What the test leaves: up to 10 of the body's characters in a row in one string, in any number of strings, and a body
spread with a character between each two (an encoding no mask reaches); a password's shape mask's limits, above.
Every string is said as one line, bounded. Any
other answer — a value outside its grammar, a URL other than the one its parts build, a password of another user,
another user than the one asked — is a failure naming the request and the status, never the body, exit 1.

The CLI prints the answer as `mason user` prints the same answer for a project (`src/cli/user.ts`'s renderers), the
`--json` shape included; a list's headline names the replica (`2 users of acme/shop`), and each next step `mason user …`
names it too (`mason user list --replica acme/shop`).

A refusal, Mason's on the replica or the service's own, is a `/v1/` failure (below), its status Mason's own for a
refusal of Mason's: `400` a request Mason cannot take (a `--set` its role does not declare, an attribute missing, an
address range it does not take) or the service cannot enforce (a `from` beyond its limits, above), `404`
no such user or role (and no such replica), `409` refused (a name taken), `500` failed. Its words are said as they came,
each as one line (a refusal's `fix` written over several lines, such as the lines to add to `roles.yml`, joined by
spaces); its code the CLI's by the status, never `usage`; the CLI's next step `mason login` ("sign in again") for a
`401` or `403`, else `mason user list --replica <org>/<name>` ("the replica's users").

## A replica's page: `mason ui --replica`

`mason ui --replica <org>/<name>` (else `MASON_REPLICA`) opens the web page of a replica's Mason (the Overview, the
Tables, the Users, Observability: what `mason ui` opens for a local run) in the browser of the organisation's owner.
The CLI asks the service for a one-use, short-lived address of the page, and opens it, as `mason login` opens its
sign-in page. How the service serves the page behind that address is the service's own; the CLI only opens it.

**The page is read-only.** A page opened this way shows the replica; it changes nothing. The service passes the page
and its reads (`GET`, such as `/api/state`, `/api/users`, `/api/requests`) to Mason on the replica, and refuses every
request that would change the replica (every other method, such as `POST /api/users`, `POST /api/pick`, `POST
/api/cancel`), because the service audits every change and a write through the page would skip that. A replica's users
are changed with `mason user … --replica` ("The users of a replica", above), which the service audits.

### `POST /v1/replicas/{org}/{name}/ui`

`Authorization: Bearer <token>`, no body. `{org}` and `{name}` follow the deploy's grammar (each
`^[a-z0-9][a-z0-9-]{0,62}$`), checked before a byte is sent, so both are safe in the path unescaped.

**Who may call it: a person's login (`masondata_pat_…`) whose role in the organisation is `owner`.** An `admin` or a
`viewer` is refused, and so is every CI token (`masondata_ci_…`), whatever its scopes: `403`. The CLI cannot tell a
login's role or a token's kind (a token is opaque to it), so the refusal is the service's alone.

`200`, JSON:

```json
{ "url": "https://r-7f3a.ui.app.example.com/?ticket=3q2-7Zk9", "expiresAt": "2026-11-07T10:05:00.000Z" }
```

| Key | Held to |
|---|---|
| `url` | the page's one-use address (below) |
| `expiresAt` | when the address stops opening the page: ISO 8601 with its zone |

Any other key (a `next` included) is never read.

**The address.** It opens the replica's page once, for a few minutes (the service decides how long, and says it in
`expiresAt`; five minutes or less is the intent), and after that first use, or once it expires, it opens nothing.
It carries no token of the login it was asked with, and no secret that outlives it. The CLI holds it to all of this
before it is opened or printed, and refuses an answer that breaks any of it:

- an absolute URL, at most 2048 characters;
- on one of two kinds of origin:
  - the service's own: the base URL's scheme, host and port (`MASON_CLOUD_URL`'s, or the default); or
  - a separate origin the service names, so that Mason's page shares neither the service's session cookie nor its
    root-absolute paths (`/app.js`, `/api/state`): `https:`, on the base URL's port, and a host that is a subdomain of
    the base URL's host, by its labels: `r-7f3a.ui.app.example.com` under `app.example.com`. Never another domain,
    never a host that merely ends in the same letters (`evilapp.example.com`), never `http:`, never another port, and
    none at all under a base URL whose host is an IP address.

  An address on any other origin, or of another scheme (`javascript:`, `file:`, `data:`), is refused naming the origin
  it named, code `refused`, exit 1: it would send the person to an address nobody chose;
- no user or password in it;
- as the URL parser writes it (dot segments removed, a host in its `xn--` form), only `https://` (or `http://` for a
  service on this machine), then the host and port, then a path and an optional query of letters, digits and
  `. _ ~ / ? = + -` alone: the same grammar as the sign-in page the CLI opens. So no shell or `cmd /c start` reads
  anything in it, and a query holds at most one `name=value` (no `&`, no `%` escape, no `#`);
- carrying no secret: every string of the answer, each key included, is put to the exact test first (the token the
  CLI holds, whole or 11 of its body in a row in any reading, and anything shaped as a token or a Mason user's
  password; "The users of a replica" says how), and the address as it is printed is put to the test again. An answer
  that carries one anywhere is refused whole, and nothing of it is printed or opened.

An answer that breaks any other of these is a failure naming the request and the status, never the body, exit 1.

**What the CLI does with it.**

- On a terminal or not, it opens the address in the browser (`open` on macOS, `start` on Windows, `xdg-open`
  elsewhere), unless `--no-open` or `--json` is given. Opened, the address is NOT printed: the browser used it, and it
  opens the page once. Not opened (`--no-open`, or a browser that would not start, which is said), it is printed once,
  in the report's `url` row on stdout, for the person at the terminal, who is told to paste it nowhere else.
- `--json` prints `{ url, replica: "<org>/<name>", expiresAt, next }` on stdout and opens nothing, so an agent can
  hand the address on.
- The address is never written to a log or to stderr, and never repeated in a failure.
- `--replica` beside `--ssh`, `--bridge`, `--mason`, `--timeout` or `--local-port` is a wrong line (exit 2), and nothing
  is sent. `MASON_REPLICA` is read only when neither `--ssh` nor `--bridge` names a target.

**Refusals.** Each is a `/v1/` failure (below), said as the service worded it; the CLI's code is by the status, and its
next step is its own, never the service's:

| Status | When | The CLI's next step |
|---|---|---|
| `401` | no login, or one that expired or was revoked | `mason login`; with `MASON_TOKEN` set, `env -u MASON_TOKEN mason ui --replica <org>/<name>` |
| `403` | a login that is not the organisation's owner (an admin, a viewer), or any CI token | `mason login`, "sign in as the organisation's owner"; with `MASON_TOKEN` set, `env -u MASON_TOKEN mason ui --replica <org>/<name>` |
| `404` | no such organisation, the login is not a member, or no such replica in it | `mason replica list <org>` |
| `409` | the replica is not `ready` (`checking`, `creating`, `failed`, `deleting`, `deleted`) | `mason replica status <org>/<name>`, then `mason ui --replica <org>/<name>` again |
| `503` | the replica is `ready` but its machine is not connected to the service now | as for `409` |
| `429` | too many pages asked for in a short time | `mason ui --replica <org>/<name>` again in a moment |

A `409` or a `503` should carry `Retry-After` (delta-seconds, 1 to 3600): the CLI says it ("again in 30 s, as the
service asks"), and adds a fix of its own ("try again in 30 s; mason replica status … says whether it is ready") when
the service sent none. It never waits or retries by itself: one request, then the person runs the command again. A
`409` or `503` without the failure shape (a proxy's page) is said in the CLI's words, never its body: "the replica
<org>/<name> is not ready to open its page".

**The audit row.** The service writes one row in its audit log for every address it answers with `200`, and for every
first use of one: who (the login's account), when, from which address, which organisation and replica, and whether
the address was answered or used. The row never holds the address, its one-use part, or any token. The CLI cannot
write the row, and never says that it did.

## Failures of `/v1/`

Every `/v1/` endpoint fails with an HTTP 4xx or 5xx and the CLI's own failure shape, the one `--json` prints:

```json
{ "error": { "code": "unauthenticated", "message": "…", "why": "…", "fix": "…" }, "next": [{ "command": "mason login", "what": "…" }] }
```

`why`, `fix` and `next` are optional. `code` is lowercase letters, digits and `_`. A `401` has the code
`unauthenticated`.

Nothing in it decides what the CLI does; its words are shown, never obeyed:

- `message`, `why` and `fix` are said as the service wrote them, never re-worded, each as one line (above), a token
  masked.
- The CLI's code, and so its exit code, is its own, from the HTTP status: `404` is `not_found`, any other 4xx
  `refused`, anything else `failed`, each exit 1. It is never `usage` (exit 2) or `timeout` (exit 124), whatever the
  service says. The service's `code` is kept as information at the end of `why`: `(the service said unauthenticated,
  HTTP 401)`. So `--json`'s `error.code` is always one of the CLI's own codes (`mason help agent` lists them).
- The service's `next` is never read. The CLI cannot know what a command the service names would do to this machine
  (`mason destroy`, `mason ui --ssh <anywhere>`, a shell line), and a coding agent runs the step it is given. The next
  step is the CLI's own, by status: `mason login` ("sign in again") for a `401` or `403`, else `mason login` ("try
  again in a moment").

## Tokens

A token is opaque to the CLI: it is never parsed. The documented forms are `masondata_pat_` (a person's login) and
`masondata_ci_` (for CI), each followed by 43 base64url characters, so a leaked one can be found by secret scanning.

- It never reaches a command line: no flag takes one.
- It is never printed, logged or put in `--json`. It is masked in anything printed from the service, as is anything of
  either documented form.
- `MASON_TOKEN` in the environment (CI) comes before a saved login. `mason login` with it set is refused, and says how
  to sign in anyway (`env -u MASON_TOKEN mason login`). `mason logout` says it cannot remove an environment variable.

## Where the login is kept

`$XDG_CONFIG_HOME/mason/credentials.json`, else `~/.config/mason/credentials.json`: never in a project.

```json
{ "version": 1, "logins": { "https://app.masondata.ai": { "token": "…", "email": "ada@example.com", "savedAt": "2026-11-02T10:00:00.000Z" } } }
```

- The file is 0600 in a 0700 folder, written beside its name and renamed over it.
- A file or folder another user can read, or that belongs to another user, is refused with the exact `chmod` to run.
  A symbolic link is not followed.
- A file that cannot be parsed is refused with its path, never overwritten, and nothing of its text is repeated.
- On Windows, mode bits say nothing of who can read a file, so these checks are POSIX's. The file is in the user's own
  profile.
