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
  alone, never its body. Every string the CLI prints from the service has its control characters replaced and is
  bounded in length. A token is masked wherever it appears.

## Signing in: the device authorization grant (RFC 8628)

### `POST /oauth/device/code`

Form body: `client_id=mason-cli`, `device_name=<the machine's hostname, printable, at most 64 characters>`.

`200`, JSON:

| Key | |
|---|---|
| `device_code` | opaque, printable ASCII, at most 2048 characters; never shown |
| `user_code` | 8 letters, shown as `XXXX-XXXX` (sent with or without the hyphen) |
| `verification_uri` | the page where the code is entered: `https://` (or `http://` to this machine) |
| `verification_uri_complete` | optional: the same page with the code filled in, which the CLI shows and opens |
| `expires_in` | seconds the code lasts, 1 to 3600 |
| `interval` | seconds between polls, 1 to 300 (5 when absent) |

On a terminal the CLI opens the page in a browser when it can. It opens only an address of letters, digits and
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

## Failures of `/v1/`

Every `/v1/` endpoint fails with an HTTP 4xx or 5xx and the CLI's own failure shape, the one `--json` prints:

```json
{ "error": { "code": "unauthenticated", "message": "…", "why": "…", "fix": "…" }, "next": [{ "command": "mason login", "what": "…" }] }
```

`why`, `fix` and `what` are optional. `code` is lowercase letters, digits and `_`. The CLI says it as it says any
failure, never re-worded (a token in it is masked). A `401` has the code `unauthenticated` and `next` `mason login`.

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
