/** `mason destroy` (src/cli/machine.ts): this folder's project's copy and state removed, its files kept, its replication objects dropped. */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DESTROY_USAGE, removeProject, destroy } from "../src/cli/machine.ts";
import { DUCK_FILE, isProject, newConfig, readProject, writeConfig, type Project } from "../src/cli/project.ts";
import type { DevRun } from "../src/cli/runs.ts";

/** A project in a temporary folder, with the files a run leaves. */
function fakeProject(): { home: string; shop: Project } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mason-machine-"));
  const root = path.join(home, "code", "shop");
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  fs.writeFileSync(path.join(root, "mason", "sources", "shop_dev.yml"), "kind: postgres\nurl: postgres://u:secret@localhost:5432/shop_dev\ntables:\n  orders: {}\n");
  writeConfig(path.join(root, ".mason"), newConfig("shop", "mason", false));
  return { home, shop: readProject(root) as Project };
}

/** A project, read as a command reads it: never a broken one here. */
function project(root: string): Project {
  const p = readProject(root);
  assert.ok(isProject(p), `${root} holds a readable project`);
  return p;
}

test("removing a running project stops Mason first, then removes its copy and state", async () => {
  const { home, shop } = fakeProject();
  try {
    fs.writeFileSync(path.join(shop.dir, DUCK_FILE), "x");
    const killed: number[] = [];
    const run = (p: Project): DevRun => ({ name: "shop", root: p.root, home: p.dir, folder: p.folder, pid: 4242, apiKey: "k", control: { url: "c", token: "t" },
      postgresUrl: "postgresql://127.0.0.1:5433/shop", postgresListener: { host: "127.0.0.1", tls: null } });
    const removed = await removeProject(shop, {
      state: async (p) => ({ kind: "up", run: run(p) }),
      kill: (pid) => { killed.push(pid); }, isAlive: (pid) => !killed.includes(pid), stopSupervisor: async () => null,
    });
    assert.deepEqual(killed, [4242]);
    assert.equal(removed[0], "stopped Mason (pid 4242)");
    assert.ok(!fs.existsSync(path.join(shop.dir, DUCK_FILE)), "the copy is gone");
    // A RUN THAT IS ALIVE AND DOES NOT ANSWER (the test server: destroy deleted a 58 GB copy under a hung
    // run, which kept the file open, so the disk was not even freed): nothing is removed, the way out said
    fs.writeFileSync(path.join(shop.dir, DUCK_FILE), "x");
    await assert.rejects(removeProject(shop, { state: async (p) => ({ kind: "hung", run: run(p) }), kill: (pid) => { killed.push(pid); }, stopSupervisor: async () => null }),
      /^Error: Mason for shop is running \(pid 4242\) but does not answer its commands, so nothing was removed: mason stop ends it \(SIGKILL after 15 s\), then mason destroy$/);
    assert.ok(fs.existsSync(path.join(shop.dir, DUCK_FILE)), "the copy is kept under a hung run");
    assert.deepEqual(killed, [4242], "nothing signalled");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("removing a stopped project keeps config.json and the project's files, and forgets the server it was copied from", async () => {
  const { home, shop } = fakeProject();
  try {
    fs.writeFileSync(path.join(shop.dir, DUCK_FILE), "x");
    fs.writeFileSync(path.join(shop.dir, "mason.log"), "log\n");
    fs.writeFileSync(path.join(shop.dir, "users.json"), "{}\n");
    // the self-signed certificate is the fingerprint a tool pinned: kept, like the users
    fs.writeFileSync(path.join(shop.dir, "postgres-tls.crt"), "cert\n");
    fs.writeFileSync(path.join(shop.dir, "postgres-tls.key"), "key\n");
    const cfg = project(shop.root).config;
    cfg.sourceServer = { systemIdentifier: "1", database: "shop_dev" };
    writeConfig(shop.dir, cfg);
    const removed = await removeProject(project(shop.root), { state: async () => ({ kind: "none", run: null }), stopSupervisor: async () => null });
    assert.match(removed.join("\n"), /\.mason\/ \(duck\.db, mason\.log\)/, "what was removed, by name: never the users or the certificate");
    assert.deepEqual(fs.readdirSync(shop.dir).sort(), ["config.json", "postgres-tls.crt", "postgres-tls.key", "users.json"]);
    assert.ok(fs.existsSync(path.join(shop.folder, "sources", "shop_dev.yml")), "the files are the developer's");
    assert.equal(project(shop.root).config.sourceServer, null, "the next start records the server again");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("mason destroy on a demo project: the demo database goes with the copy, said; config.demo stays, so the next start seeds it again", async () => {
  const { home, shop } = fakeProject();
  try {
    const cfg = project(shop.root).config as ReturnType<typeof project>["config"] & { demo?: boolean };
    cfg.demo = true;
    writeConfig(shop.dir, cfg);
    fs.writeFileSync(path.join(shop.dir, DUCK_FILE), "x");
    fs.mkdirSync(path.join(shop.dir, "demo", "base"), { recursive: true });
    fs.writeFileSync(path.join(shop.dir, "demo", "base", "1"), "rows");
    const chunks: string[] = [];
    const io = { out: (m: string) => { chunks.push(`${m}\n`); }, err: (m: string) => { chunks.push(`${m}\n`); } };
    const code = await destroy([], { io, cwd: shop.root, removeProject: (p) => removeProject(p, { state: async () => ({ kind: "none", run: null }), stopSupervisor: async () => null }) });
    assert.equal(code, 0, chunks.join(""));
    assert.ok(!fs.existsSync(path.join(shop.dir, "demo")), "the demo database is state, like the copy");
    assert.deepEqual(fs.readdirSync(shop.dir), ["config.json"]);
    assert.equal((project(shop.root).config as { demo?: boolean }).demo, true, "still the demo's project: the next mason start makes and seeds it");
    assert.match(chunks.join(""), /^Removed shop\n {2}removed {3}.*\.mason\/ \(demo, duck\.db\)\n {2}kept {6}your files in .*\/shop\/mason, \.mason\/config\.json and the users — not the demo database, which went with the copy: the next mason start seeds it again\n/);
    assert.match(DESTROY_USAGE, /A demo project's database \(mason init demo, in \.mason\/demo\/\)\n {2}goes with the copy: the next mason start makes and seeds it again\./);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("in replication mode the slot is dropped on the database the copy came from: a url: edited since is refused, the slot named", async () => {
  // the review of the sources file: destroy dropped on the database the file named NOW, found nothing there,
  // and the real slot went on holding the first database's WAL
  const { home, shop } = fakeProject();
  try {
    fs.writeFileSync(path.join(shop.dir, DUCK_FILE), "x");
    const cfg = project(shop.root).config;
    cfg.changes = "replication";
    cfg.sourceServer = { systemIdentifier: "7", database: "shop_old" };
    writeConfig(shop.dir, cfg);
    const asked: string[] = [];
    await assert.rejects(removeProject(project(shop.root), { state: async () => ({ kind: "none", run: null }), stopSupervisor: async () => null,
      dropReplication: async (source) => { asked.push(source.database); return ["replication slot mason_dev_shop_shop_dev"]; } }),
    (e: Error) => /^removed .*; but not its publication and replication slot: the sources file names shop_dev now, and the copy came from shop_old, where the slot is: put that database's URL back in the sources file and run mason destroy again, or drop them on shop_old by hand\. They hold the database's WAL while they exist: drop them by hand — /.test(e.message));
    assert.equal(asked.length, 0, "nothing is dropped on the other database");
    // the database the copy came from: its slot dropped there
    cfg.sourceServer = { systemIdentifier: "7", database: "shop_dev" };
    writeConfig(shop.dir, cfg);
    const removed = await removeProject(project(shop.root), { state: async () => ({ kind: "none", run: null }), stopSupervisor: async () => null,
      dropReplication: async (source) => { asked.push(source.database); return ["replication slot mason_dev_shop_shop_dev"]; } });
    assert.deepEqual(asked, ["shop_dev"]);
    assert.ok(removed.includes("replication slot mason_dev_shop_shop_dev from shop_dev"), removed.join("\n"));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("mason destroy: this folder's project removed and said; a folder with no project is refused; a failure is said and exit 1", async () => {
  const { home, shop } = fakeProject();
  try {
    const chunks: string[] = [], errs: string[] = [];
    const io = { out: (m: string) => { chunks.push(`${m}\n`); }, err: (m: string) => { errs.push(`${m}\n`); } };
    assert.equal(await destroy([], { io, cwd: shop.root, removeProject: async () => [".mason/duck.db"] }), 0);
    assert.match(chunks.join(""), /^Removed shop\n  removed   \.mason\/duck\.db\n  kept      your files in .*\/shop\/mason, \.mason\/config\.json and the users\n\nNext:\n  mason start /);
    const failing = await destroy([], { io, cwd: shop.root, removeProject: async () => { throw new Error("duck.db is open in another process"); } });
    assert.equal(failing, 1);
    assert.match(errs.join(""), /mason destroy: .*duck\.db is open in another process/);
    const nowhere = await destroy([], { io, cwd: home });
    assert.equal(nowhere, 1);
    assert.match(errs.join(""), /no Mason project here or above/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("a project in replication mode takes its slot and publication with it; when they cannot go, the rest does and the failure says how", async () => {
  const { home, shop } = fakeProject();
  try {
    const cfg = project(shop.root).config;
    cfg.changes = "replication";
    writeConfig(shop.dir, cfg);
    const asked: Array<{ database: string; slot: string; publication: string; owned: boolean }> = [];
    const removed = await removeProject(project(shop.root), {
      state: async () => ({ kind: "none", run: null }), stopSupervisor: async () => null,
      dropReplication: async (s, o) => { asked.push({ database: s.database, ...o }); return [`replication slot ${o.slot}`, `publication ${o.publication}`]; },
    });
    assert.deepEqual(asked, [{ database: "shop_dev", slot: "mason_dev_shop_shop_dev", publication: "mason_dev_shop_shop_dev", owned: true }]);
    assert.deepEqual(removed.slice(0, 2), ["replication slot mason_dev_shop_shop_dev from shop_dev", "publication mason_dev_shop_shop_dev from shop_dev"]);
    // the database is away: the copy still goes, and the error names what is left and the statements that drop it
    await assert.rejects(removeProject(project(shop.root), {
      state: async () => ({ kind: "none", run: null }), stopSupervisor: async () => null,
      dropReplication: async () => { throw new Error("could not connect to drop them: nothing is listening on localhost:5432"); },
    }), /but not its publication and replication slot: could not connect to drop them: .* drop them by hand — SELECT pg_drop_replication_slot\('mason_dev_shop_shop_dev'\) .* DROP PUBLICATION IF EXISTS mason_dev_shop_shop_dev;$/);
    // a publication the operator named is its owner's: the drop is asked for the slot alone, and a failure says so
    cfg.publication = "app_pub";
    writeConfig(shop.dir, cfg);
    asked.length = 0;
    await removeProject(project(shop.root), {
      state: async () => ({ kind: "none", run: null }), stopSupervisor: async () => null,
      dropReplication: async (s, o) => { asked.push({ database: s.database, ...o }); return [`replication slot ${o.slot}`]; },
    });
    assert.deepEqual(asked, [{ database: "shop_dev", slot: "mason_dev_shop_shop_dev", publication: "app_pub", owned: false }]);
    await assert.rejects(removeProject(project(shop.root), {
      state: async () => ({ kind: "none", run: null }), stopSupervisor: async () => null,
      dropReplication: async () => { throw new Error("could not connect to drop them: nothing is listening on localhost:5432"); },
    }), (e: Error) => /but not its replication slot: .* drop them by hand — SELECT pg_drop_replication_slot\('mason_dev_shop_shop_dev'\) [^;]*;$/.test(e.message));
    // WHAT THE START RECORDED is what goes (a slot made under another name rule, or before the sources file was renamed):
    // never the name computed again, which would find nothing and leave the real slot holding the WAL; when it cannot
    // go, the record stays for the next destroy, and once it went nothing names it
    cfg.publication = null;
    cfg.replication = { slot: "mason_dev_shop", publication: "mason_dev_shop", owned: true };
    writeConfig(shop.dir, cfg);
    asked.length = 0;
    await assert.rejects(removeProject(project(shop.root), {
      state: async () => ({ kind: "none", run: null }), stopSupervisor: async () => null,
      dropReplication: async () => { throw new Error("could not connect to drop them: nothing is listening on localhost:5432"); },
    }), /drop them by hand — SELECT pg_drop_replication_slot\('mason_dev_shop'\) .* DROP PUBLICATION IF EXISTS mason_dev_shop;$/);
    assert.deepEqual(project(shop.root).config.replication, cfg.replication, "not dropped: still recorded");
    await removeProject(project(shop.root), {
      state: async () => ({ kind: "none", run: null }), stopSupervisor: async () => null,
      dropReplication: async (s, o) => { asked.push({ database: s.database, ...o }); return [`replication slot ${o.slot}`, `publication ${o.publication}`]; },
    });
    assert.deepEqual(asked, [{ database: "shop_dev", slot: "mason_dev_shop", publication: "mason_dev_shop", owned: true }]);
    assert.equal(project(shop.root).config.replication, null, "dropped: nothing names it");
    // a polling project made nothing on the database: nothing is asked of it
    cfg.changes = "poll";
    writeConfig(shop.dir, cfg);
    await removeProject(project(shop.root), { state: async () => ({ kind: "none", run: null }), stopSupervisor: async () => null,
      dropReplication: async () => { throw new Error("must not be called"); } });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
