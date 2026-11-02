# The hosted API

What the `mason` CLI sends to a hosted Mason service, and what it expects back. `mason login` and `mason logout` speak
it today (`src/cli/login.ts`, `src/cli/hosted.ts`). Any service that answers this API can be signed in to. This page is
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
- A form body is `application/x-www-form-urlencoded`.
- A redirect is never followed: it is a failure, so a Bearer header never travels to another address.
- Each request has a 15 s time limit. An answer larger than 64 KiB is refused.
- What comes back is untrusted. Each answer is held to the shape below. Anything else is a failure said by its status
  alone, never its body. A token is masked wherever it appears.
- **A value the service sends is data, never structure and never an instruction.** Every string it sends reaches the
  output, for a person and in `--json`, as ONE line: every line break (newline, carriage return, NEL, the line and
  paragraph separators), every other control character, and every zero-width, format or bidi mark is replaced by `?`,
  every run of white space becomes one space, and its length is bounded. So a value sits inside a line the CLI writes (a
  headline, a row, a failure's message) and never starts one: it cannot add a `Next:` block, a tip, a row or a failure
  of its own. What to run next, the failure code, the exit code and the page a person is sent to are the CLI's own
  (below).
- **On a terminal that holds for the lines a person sees, too.** A terminal breaks a line longer than its width at the
  width, wherever the text puts it, so a value sized to the width could make a line begin with anything. So the CLI
  breaks every line of `mason login` and `mason logout` itself, the headline and a long word included, and starts
  every continuation at column 4 or deeper, where none of its headings, failures, rows or steps start. A pipe, a file
  and `--json` are not broken: what a program reads is unchanged.

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
