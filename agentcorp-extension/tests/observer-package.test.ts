import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { id, observationsUrl, officeFolders, putRecord, send, validRecord } from "./helpers";

const source = resolve("../.github/extensions/agentcorp-extension");
const folder = await mkdtemp(join(tmpdir(), "agentcorp-portable-"));
const installed = join(folder, "extensions", "agentcorp-extension");
await cp(source, installed, { recursive: true });
process.env.COPILOT_HOME = folder;
const { shouldRegister } = await import(pathToFileURL(join(installed, "provider-selection.mjs")).href);
const { startServer } = await import(pathToFileURL(join(installed, "viewer-server.mjs")).href);

test("standalone extension folder serves only packaged assets and the live office to its own page", async t => {
  const manifest = JSON.parse(await readFile(join(installed, "copilot-extension.json"), "utf8"));
  assert.equal(manifest.name, "agentcorp-extension");
  assert.equal(await shouldRegister(pathToFileURL(join(installed, "extension.mjs")).href, folder), true);
  for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
    assert.ok((await readFile(join(installed, notice), "utf8")).length > 0);
  }
  const entry = await readFile(join(installed, "extension.mjs"), "utf8");
  assert.doesNotMatch(entry, /\.\.\/\.\.\/\.\.\/dist/);
  assert.doesNotMatch(entry, /add_descendant/);
  assert.match(entry, /shouldRegister/);
  const { server, url } = await startServer("root");
  t.after(() => new Promise<void>((done, reject) => server.close((error?: Error) => error ? reject(error) : done())));
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /AgentCorp · Live sessions/);
  const references = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
  assert.ok(references.some(path => path.endsWith(".js")));
  assert.ok(references.some(path => path.endsWith(".css")));
  for (const reference of references) {
    const asset = await fetch(new URL(reference, url));
    assert.equal(asset.status, 200, reference);
    assert.ok((await asset.arrayBuffer()).byteLength > 0, reference);
  }
  const assets = await readdir(join(installed, "viewer", "assets"));
  assert.deepEqual(assets.sort(), references.map(path => path.split("/").at(-1)!).sort());
  assert.equal((await fetch(new URL("/index.html", url))).status, 404);
  assert.equal((await fetch(new URL("/../package.json", url))).status, 404);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  assert.equal((await send(url, { headers: { host: "not-localhost.example" } })).status, 403);

  const keyed = observationsUrl(url);
  const unkeyed = new URL("/api/observations", url);
  const wrongKey = new URL(keyed);
  wrongKey.searchParams.set("key", keyed.searchParams.get("key")!.replace(/^./, first => first === "0" ? "1" : "0"));
  const shortKey = new URL(keyed);
  shortKey.searchParams.set("key", keyed.searchParams.get("key")!.slice(1));
  for (const target of [unkeyed, wrongKey, shortKey]) assert.equal((await send(target)).status, 403, target.search);
  assert.deepEqual(JSON.parse((await send(keyed)).body), {
    root: "root", sessions: [], overflow: 0, counts: { needsYou: 0, error: 0, working: 0, idle: 0 },
  });

  const office = await officeFolders(folder, "presence");
  await t.test("returns HTTP 500 when the office folder isn't private", async t => {
    const logged = t.mock.method(console, "error", () => {});
    await chmod(office, 0o755);
    try {
      const failure = await send(keyed);
      assert.equal(failure.status, 500);
      assert.equal(failure.body, "Office update unavailable.");
      assert.equal(logged.mock.callCount(), 1);
    } finally {
      await chmod(office, 0o700);
    }
  });

  const now = Date.now();
  await putRecord(office, {
    ...validRecord(id(1), now, {
      title: "Fix the build", mode: "autopilot", state: "working", kind: "terminal", activity: "Running a command",
      since: new Date(now - 30_000).toISOString(), owner: "b".repeat(32),
    }),
    prompt: "private-prompt", code: "private-code", cwd: "/private-path",
  } as ReturnType<typeof validRecord>);
  await putRecord(office, validRecord(id(2), now, {
    title: "Ship the docs", mode: "plan", state: "question", activity: "Has a question for you", since: new Date(now - 10_000).toISOString(),
  }));
  await putRecord(office, validRecord(id(3), now, { updatedAt: new Date(now - 10 * 60_000).toISOString() }));
  const artifacts = join(office, "artifacts");
  await mkdir(artifacts, { mode: 0o700 });
  await writeFile(join(artifacts, "heartbeat-extra.json"), JSON.stringify({ id: "extra", phase: "thinking", owner: "private-extra-owner", at: now }));
  const packageFiles = await readdir(installed);
  const presenceFiles = await readdir(join(office, "presence"));

  const live = await send(keyed);
  assert.equal(live.status, 200);
  assert.equal(live.headers["content-type"], "application/json");
  assert.equal(live.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(live.body), {
    root: "root",
    sessions: [
      {
        id: id(2), title: "Ship the docs", mode: "plan", state: "question", kind: null, activity: "Has a question for you",
        since: new Date(now - 10_000).toISOString(), url: `ghapp://sessions/${id(2)}`,
      },
      {
        id: id(1), title: "Fix the build", mode: "autopilot", state: "working", kind: "terminal", activity: "Running a command",
        since: new Date(now - 30_000).toISOString(), url: `ghapp://sessions/${id(1)}`,
      },
    ],
    overflow: 0,
    counts: { needsYou: 1, error: 0, working: 1, idle: 0 },
  });
  assert.doesNotMatch(live.body, /private-|b{32}/);
  assert.deepEqual(await readdir(installed), packageFiles);
  assert.deepEqual(await readdir(join(office, "presence")), presenceFiles);
});

test.after(async () => { await rm(folder, { recursive: true, force: true }); });
