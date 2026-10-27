// A port setting is a whole number from 0 to 65535, or the process refuses to start naming it (src/lib/port.ts).
// Kubernetes sets MASON_PG_PORT=tcp://<ip>:5433 in every pod of a namespace with a Service named mason-pg.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parsePort } from "../src/lib/port.ts";
import { pgOptions } from "../src/cdc/source.ts";

test("a port is a whole number from 0 to 65535; unset or empty is the default", () => {
  assert.deepEqual(parsePort("P", undefined, 4141), { port: 4141 });
  assert.deepEqual(parsePort("P", "", 4141), { port: 4141 });
  for (const ok of ["0", "80", "4141", "65535"]) assert.deepEqual(parsePort("P", ok, 1), { port: Number(ok) });
  for (const bad of ["65536", "-1", "4141.5", "1e3", " 4141", "4141abc", "x", "123456"]) {
    const r = parsePort("P", bad, 1);
    assert.ok(r.problem, bad);
    assert.ok(r.problem.startsWith(`P=${bad} is not a port`), r.problem);
    assert.doesNotMatch(r.problem, /Kubernetes/);
  }
});

test("a Kubernetes service link is named for what it is, with the fix", () => {
  const r = parsePort("MASON_PG_PORT", "tcp://10.0.0.1:5433", 5433);
  assert.ok(r.problem);
  assert.match(r.problem, /^MASON_PG_PORT=tcp:\/\/10\.0\.0\.1:5433 is not a port/);
  assert.match(r.problem, /Kubernetes service link/);
  assert.match(r.problem, /enableServiceLinks: false/);
});

test("PG_PORT is checked the same way: a service link would win over DATABASE_URL's port", () => {
  const pg = { PG_HOST: "h", PG_DATABASE: "d", PG_USER: "u" };
  assert.equal(pgOptions(pg).port, 5432);
  assert.equal(pgOptions({ ...pg, PG_PORT: "6543" }).port, 6543);
  assert.throws(() => pgOptions({ ...pg, PG_PORT: "tcp://10.0.0.2:5432" }),
    /^Error: PG_PORT=tcp:\/\/10\.0\.0\.2:5432 is not a port .*Kubernetes service link.*enableServiceLinks: false/);
  assert.throws(() => pgOptions({ ...pg, PG_PORT: "x" }), /PG_PORT=x is not a port/);
});
