import assert from "node:assert/strict";
import { chmod, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { readRoster } from "../../.github/extensions/agentcorp-extension/presence.mjs";
import { WORDS, madeUpName, type Kind, type State } from "../../.github/extensions/agentcorp-extension/status.mjs";
import {
  DAY, LETTERED, childOf, crossBlock, id, officeFolders, patchFs, pick, publisherFor, putRecord, rpcMetadata, sessionFolder, temporary,
  validRecord,
} from "./helpers";

test("the roster lists sessions that need you first, oldest wait first, then errors, working and idle", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "presence");
  const now = Date.now();
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  const entries: Array<[number, State, string, number]> = [
    [1, "idle", "Charlie", 300],
    [2, "working", "Agent 10", 100],
    [3, "permission", "Zulu", 20],
    [4, "question", "Yankee", 30],
    [5, "working", "Agent 2", 50],
    [6, "idle", "alpha", 200],
    [7, "error", "Echo", 40],
    [8, "plan-ready", "Xray", 10],
    [9, "idle", "Alpha", 250],
  ];
  for (const [n, state, title, waited] of entries) {
    await putRecord(office, validRecord(id(n), now, { state, title, since: ago(waited), activity: WORDS[state] }));
  }
  const roster = await readRoster(office, { now });
  assert.deepEqual(roster.agents.map(agent => agent.sessionId), [4, 3, 8, 7, 5, 2, 6, 9, 1].map(id));
  assert.deepEqual(roster.counts, { needsYou: 3, error: 1, working: 2, idle: 3 });
  assert.equal(roster.problem, undefined);
  assert.deepEqual(roster.agents[0], {
    sessionId: id(4),
    title: "Yankee",
    mode: "interactive",
    state: "question",
    since: ago(30),
    activity: WORDS.question,
    kind: null,
    updatedAt: new Date(now - 1000).toISOString(),
    url: `ghapp://sessions/${id(4)}`,
  });
});

test("the roster says what kind of work a working agent is doing, and nothing for other states", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "presence");
  const now = Date.now();
  const cases: Array<[number, Record<string, unknown>, Kind | null]> = [
    [1, { state: "working", kind: "terminal" }, "terminal"],
    [2, { state: "working", kind: "delegating" }, "delegating"],
    [3, { state: "working", kind: "dancing" }, "working"],
    [4, { state: "working" }, "working"],
    [5, { state: "idle", kind: "editing" }, null],
    [6, { state: "question", kind: "research" }, null],
    [7, { state: "error", kind: "terminal" }, null],
  ];
  for (const [n, fields] of cases) await putRecord(office, validRecord(id(n), now, fields));
  const kinds = Object.fromEntries((await readRoster(office, { now })).agents.map(agent => [agent.sessionId, agent.kind]));
  assert.deepEqual(kinds, Object.fromEntries(cases.map(([n, , kind]) => [id(n), kind])));
});

test("the roster cleans titles and fills in missing names and activities", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "presence");
  const now = Date.now();
  await putRecord(office, validRecord(id(1), now, { title: "Ship\nthe\u202E fix", activity: "Running\ta command" }));
  await putRecord(office, validRecord(id(2), now, { title: "", activity: "", state: "working", mode: null }));
  const agents = Object.fromEntries((await readRoster(office, { now })).agents.map(agent => [agent.sessionId, agent]));
  assert.deepEqual(pick(agents[id(1)], ["title", "activity"]), { title: "Ship the fix", activity: "Running a command" });
  assert.deepEqual(pick(agents[id(2)], ["title", "activity", "mode"]), { title: madeUpName(id(2)), activity: WORDS.working, mode: null });
});

test("the roster skips stale, invalid and unsafe records", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "presence");
  const now = Date.now();
  const at = (offset: number) => new Date(now + offset).toISOString();
  await putRecord(office, validRecord(id(1), now));
  await putRecord(office, validRecord(id(2), now, { mode: null }));
  const skipped = [
    validRecord(id(10), now, { updatedAt: at(-46_000), since: at(-50_000) }),
    validRecord(id(11), now, { updatedAt: at(6_000) }),
    validRecord(id(12), now, { since: at(0), updatedAt: at(-1_000) }),
    validRecord(id(13), now, { state: "sleeping" }),
    validRecord(id(14), now, { mode: "turbo" }),
    validRecord(id(15), now, { owner: "not-an-owner" }),
    validRecord(id(16), now, { version: 2 }),
    validRecord(id(17), now, { title: "x".repeat(5000) }),
    validRecord(id(18), now, { updatedAt: "yesterday" }),
  ];
  for (const record of skipped) await putRecord(office, record);
  const named = (n: number) => `${id(n)}.${"a".repeat(32)}.json`;
  await putRecord(office, validRecord(id(31), now), named(30));
  await putRecord(office, validRecord(id(22), now, { owner: "b".repeat(32) }), named(22));
  await putRecord(office, "{\"version\":1,", named(19));
  await putRecord(office, validRecord("notes", now), "notes.json");
  await putRecord(office, validRecord(id(23), now), `${id(23)}.json`);
  const elsewhere = join(root, "elsewhere.json");
  await writeFile(elsewhere, JSON.stringify(validRecord(id(20), now)));
  await symlink(elsewhere, join(office, "presence", named(20)));
  if (process.getuid?.() !== 0) await chmod(await putRecord(office, validRecord(id(21), now)), 0o000);
  assert.deepEqual((await readRoster(office, { now })).agents.map(agent => agent.sessionId), [id(1), id(2)]);
});

test("expired records never crowd out a session that needs you", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "presence");
  const now = Date.now();
  const expired = { updatedAt: new Date(now - 46_000).toISOString(), since: new Date(now - 50_000).toISOString() };
  for (let n = 1; n <= 250; n += 1) await putRecord(office, validRecord(id(n), now, expired));
  await putRecord(office, validRecord(id(999), now, { state: "permission" }));
  const roster = await readRoster(office, { now });
  assert.deepEqual(roster.agents.map(agent => agent.sessionId), [id(999)]);
  assert.deepEqual(roster.counts, { needsYou: 1, error: 0, working: 0, idle: 0 });
});

test("the roster fails instead of guessing when a record or marker can't be read", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "presence", "my-copilot");
  const now = Date.now();
  const record = await putRecord(office, validRecord(id(1), now));
  const marker = join(office, "my-copilot", id(2));
  await putRecord(office, validRecord(id(2), now));
  await writeFile(marker, "", { mode: 0o600 });
  const broken = new Set<string>();
  const ioError = () => Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
  patchFs(t, "open", real => (async (...args: Parameters<typeof real>) => {
    if (broken.has(String(args[0]))) throw ioError();
    return real(...args);
  }) as typeof real);
  patchFs(t, "lstat", real => (async (...args: Parameters<typeof real>) => {
    if (broken.has(String(args[0]))) throw ioError();
    return real(...args);
  }) as typeof real);
  assert.deepEqual((await readRoster(office, { now })).agents.map(agent => agent.sessionId), [id(1)]);
  for (const path of [record, marker]) {
    broken.add(path);
    await assert.rejects(readRoster(office, { now }), { code: "EIO" });
    broken.delete(path);
  }
});

test("the roster shows each session once, from its freshest record", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "presence");
  const now = Date.now();
  const at = (offset: number) => new Date(now + offset).toISOString();
  const copy = (n: number, owner: string, title: string, age: number) =>
    validRecord(id(n), now, { owner: owner.repeat(32), title, updatedAt: at(-age), since: at(-30_000) });
  await putRecord(office, copy(1, "a", "Older copy", 20_000));
  await putRecord(office, copy(1, "b", "Newer copy", 1_000));
  await putRecord(office, copy(2, "a", "Newer again", 1_000));
  await putRecord(office, copy(2, "b", "Older again", 20_000));
  const roster = await readRoster(office, { now });
  assert.deepEqual(roster.agents.map(agent => [agent.sessionId, agent.title]), [[id(2), "Newer again"], [id(1), "Newer copy"]]);
  assert.equal(roster.counts.idle, 2);
});

test("the roster hides sessions known to be My Copilot", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "presence", "my-copilot");
  const markers = join(office, "my-copilot");
  const now = Date.now();
  const upper = "FEDCBA98-7654-4321-8ABC-DEF012345678";
  for (const sessionId of [id(40), id(41), id(42), id(44), LETTERED, upper]) await putRecord(office, validRecord(sessionId, now));
  await writeFile(join(markers, id(40)), "", { mode: 0o600 });
  await writeFile(join(markers, upper.toLowerCase()), "", { mode: 0o600 });
  await writeFile(join(markers, id(41)), "x", { mode: 0o600 });
  await writeFile(join(markers, id(42)), "", { mode: 0o600 });
  await utimes(join(markers, id(42)), new Date(now - 31 * DAY), new Date(now - 31 * DAY));
  await writeFile(join(root, "empty"), "");
  await symlink(join(root, "empty"), join(markers, id(44)));
  let roster = await readRoster(office, { now });
  assert.deepEqual(roster.agents.map(agent => agent.sessionId).sort(), [id(41), id(42), id(44), LETTERED].sort());
  assert.equal(roster.problem, undefined);
  await chmod(markers, 0o755);
  roster = await readRoster(office, { now });
  assert.equal(roster.agents.length, 6);
  assert.ok(roster.problem);
});

test("many My Copilot markers never crowd out a known one", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "presence", "my-copilot");
  const markers = join(office, "my-copilot");
  const now = Date.now();
  const last = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  for (let n = 100; n < 170; n += 1) await writeFile(join(markers, id(n)), "", { mode: 0o600 });
  await writeFile(join(markers, last), "", { mode: 0o600 });
  await putRecord(office, validRecord(last, now));
  assert.deepEqual((await readRoster(office, { now })).agents, []);
  const sessionId = id(2);
  const folder = await sessionFolder(root, sessionId, childOf(last, crossBlock({ from: last, name: "Renamed assistant" })));
  const { publisher, reports } = publisherFor(t, office, sessionId);
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ summary: "Delegated work", currentMode: "autopilot" }) });
  assert.deepEqual((await readRoster(office)).agents.map(agent => agent.title), ["Delegated work"]);
  assert.deepEqual(reports, []);
});

test("the roster refuses shared or redirected folders", async t => {
  const root = await temporary(t);
  const now = Date.now();
  const missing = join(root, "missing");
  assert.deepEqual(await readRoster(missing, { now }), {
    agents: [],
    counts: { needsYou: 0, error: 0, working: 0, idle: 0 },
  });
  const office = await officeFolders(root, "presence");
  await putRecord(office, validRecord(id(1), now));
  assert.equal((await readRoster(office, { now })).agents.length, 1);
  const link = join(root, "linked-office");
  await symlink(office, link);
  const cases: Array<[string, () => Promise<void>]> = [
    [link, async () => {}],
    [office, () => chmod(office, 0o755)],
    [office, async () => { await chmod(office, 0o700); await chmod(join(office, "presence"), 0o755); }],
  ];
  for (const [path, change] of cases) {
    await change();
    const roster = await readRoster(path, { now });
    assert.deepEqual(roster.agents, []);
    assert.ok(roster.problem, path);
  }
});
