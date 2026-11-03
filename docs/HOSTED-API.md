# The hosted API

What the `mason` CLI sends to a hosted Mason service, and what it expects back. `mason login`, `mason logout`,
`mason deploy` and `mason user … --replica` speak it today (`src/cli/login.ts`, `src/cli/deploy.ts`,
`src/cli/user-hosted.ts`, `src/cli/hosted.ts`). Any service that answers this API can be signed in to. This page is
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
- Each request has a 15 s time limit. An answer larger than 64 KiB is refused (1 MiB for a replica's list of users).
- What comes back is untrusted. Each answer is held to the shape below. Anything else is a failure said by its status
  alone, never its body. A token is masked wherever it appears, and so is anything shaped as a Mason user's password
  (`mason_<16 hex>_<32 hex>`), except in the one answer that makes it (`mason user add`'s, below).
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

## Deploying a project: `mason deploy`

A deploy sends a project's files to one replica and waits until Mason on the replica runs them, or refuses them. The
replica is named `{org}/{name}`: each part matches `^[a-z0-9][a-z0-9-]{0,62}$` (the CLI refuses any other before it
sends a byte, so a name is always safe in a path). Both requests carry `Authorization: Bearer <token>`.

### What the CLI checks before it sends anything

The project is checked on this machine by Mason's own readers, as `mason start` checks it before it connects: the
`mason.yml` pin, the sources file, the roles file against the tables the sources file names, and the generated
tables (a refused one is said, and does not stop the deploy, as it does not stop a start). No database is connected
to. A project a start would refuse is refused here, in the CLI's failure shape, and nothing is sent. A sources file
whose `url:` is written with its password is refused too: the service keeps the files, and a secret is never one of
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
- `mason deploy --dry-run` prints each path, its size and its sha256, and sends nothing (it needs no login).

### `POST /v1/replicas/{org}/{name}/deploys`

`Content-Type: application/json`:

```json
{ "files": [{ "path": "sources/app.yml", "sha256": "2aab…", "content": "kind: postgres\n…" }], "client": { "version": "0.7.0" } }
```

- `files` is the whole project, sorted by `path`, each path once. The replica's project becomes exactly these files: a
  file the replica had and the list lacks is removed. A deploy never merges.
- `client.version` is the CLI's version (`dev` from a checkout).
- The service checks each `sha256` against its `content`, the bounds above and the path grammar, and refuses what does
  not hold (`422 invalid`). It may refuse a body over 8 MiB with `413` before reading it.

`201`:

```json
{ "deploy": { "id": "dep_01HZX…", "status": "queued", "createdAt": "2026-11-02T10:00:00Z" } }
```

`id` matches `^[A-Za-z0-9_-]{1,64}$`, held to it before the CLI puts it in the next path (an id outside it, which could
point the next request at another path, is a failure); `status` is `queued`. Other statuses, each with the failure
shape, are said as "Failures of `/v1/`" says: their words as the service wrote them, each one line, the CLI's code
from the HTTP status (`404` `not_found`, the others `refused`), exit 1, the service's code at the end of `why`, and the
CLI's own next step (`next` is never read):

| Status | The service's `code` | When |
|---|---|---|
| `401` | `unauthenticated` | no token, or one the service does not take (the CLI's next step: `mason login`) |
| `403` | `refused` | the token may not deploy this replica (a viewer's, or a CI token made for another replica) |
| `404` | `not_found` | no such replica in that organisation, or the token's account is not in the organisation: said the same way, so it never tells whether the name exists elsewhere |
| `409` | `busy` | another deploy to this replica has not finished; `why` names its id |
| `413` | `too_large` | past a bound above; `why` names the file or the sizes |
| `422` | `invalid` | the service's own check of the files: `message` names the file and what is wrong, `why` the rest |

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
| `refused` | Mason on the replica refused the files (a sources file naming a table the database lacks, a pin of another release line): `failure` is Mason's own failure. The replica runs what it ran before | prints `failure`'s words as they came, code `refused`, exit 1 |
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

`mason user add | list | disable | enable | remove … --replica <org>/<name>` (else `MASON_REPLICA`) manages the users of
a replica's Postgres API, as `mason user` manages a project's own. Each subcommand is ONE request, and its body and its
answer are what Mason's own command server takes and answers for it (`/api/users` of a running Mason): a service passes
the request to Mason on the replica and its answer back unchanged, so Mason there checks the names, the role and the
attributes with the functions it checks them with on a laptop. Every request carries `Authorization: Bearer <token>`.
The replica's name is checked as for a deploy (each part `^[a-z0-9][a-z0-9-]{0,62}$`), and a user's name is
`^[a-z0-9][a-z0-9_.-]{0,62}$`, checked before it is put in a path, so both are always safe there unescaped.

What only the command line says is checked by the CLI first, and refused as a wrong line (exit 2) with nothing sent: a
subcommand, a user's name, a role's name (`^[a-z0-9][a-z0-9_-]{0,62}$`), a `--set` that is not `<attribute>=<value>`,
`--role` or `--set` beside a subcommand other than `add`. Nothing of a project on this machine is read or written.

| Subcommand | Request | Body | `200` |
|---|---|---|---|
| `list` | `GET /v1/replicas/{org}/{name}/users?lastUsed=1` | none | `{ users, lastUsedNote, urlNote, requestLogDays }` |
| `add <user>` | `POST /v1/replicas/{org}/{name}/users` | `{ "name", "role"?, "set"? }` | the user added (below) |
| `disable <user>` | `POST /v1/replicas/{org}/{name}/users/{user}/disable` | none | `{ disabled: { name, id, addedAt, disabledAt }, already }` |
| `enable <user>` | `POST /v1/replicas/{org}/{name}/users/{user}/enable` | none | `{ enabled: { name, id, addedAt }, already }` |
| `remove <user>` | `DELETE /v1/replicas/{org}/{name}/users/{user}` | none | `{ removed: { name, id, addedAt, removedAt } }` |

- `add`'s body is `{ "name": "metabase" }`, with `"role": "<role>"` for `--role` and `"set": ["tenant=42", …]` for each
  `--set`, in the order given, as they were written.
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
| `attributes`, `missingAttributes` | at most 64 attribute names (`^[a-z_][a-z0-9_]{0,62}$`), each a value or a list of 1 to 100; the names alone |
| `live`, `already` | booleans |
| `lastUsedNote`, `urlNote` | `null` or a string, said as one line |
| `requestLogDays` | `null` or a whole number, 1 to 36500 |
| `users` | at most 2000 |

An `add` answers with where the replica's Postgres API listens (`url`, `psql`, `host`, `port`, `sslmode`): Mason
there runs. Every string is said as one line, bounded, a token and a password masked ("Every request", above). Any
other answer — a value outside its grammar, a URL other than the one its parts build, a password of another user,
another user than the one asked — is a failure naming the request and the status, never the body, exit 1.

The CLI prints the answer as `mason user` prints the same answer for a project (`src/cli/user.ts`'s renderers), the
`--json` shape included; a list's headline names the replica (`2 users of acme/shop`), and each next step `mason user …`
names it too (`mason user list --replica acme/shop`).

A refusal, Mason's on the replica or the service's own, is a `/v1/` failure (below), its status Mason's own for a
refusal of Mason's: `400` a request Mason cannot take (a `--set` its role does not declare, an attribute missing), `404`
no such user or role (and no such replica), `409` refused (a name taken), `500` failed. Its words are said as they came,
each as one line (a refusal's `fix` written over several lines, such as the lines to add to `roles.yml`, joined by
spaces); its code the CLI's by the status, never `usage`; the CLI's next step `mason login` ("sign in again") for a
`401` or `403`, else `mason user list --replica <org>/<name>` ("the replica's users").

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
