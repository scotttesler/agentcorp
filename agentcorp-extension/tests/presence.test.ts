import assert from "node:assert/strict";
import type { PathLike, StatOptions } from "node:fs";
import fsPromises, { appendFile, lstat, mkdir, readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublisher, firstMessage, readRoster } from "../../.github/extensions/agentcorp-extension/presence.mjs";
import { WORDS, toolWords } from "../../.github/extensions/agentcorp-extension/status.mjs";
import {
  DAY, HELPER, HOUR, MEMORY_KEY, childOf, cleanUp, crossBlock, ev, eventually, exists, hasRecord, id, lines, live, myCopilotChild,
  officeFolders, patchFs, permissions, pick, publisherFor, readJson, readRecord, recordFiles, recordOf, rpcMetadata, sessionFolder,
  temporary, topLevel, userMessage, type Bag, type Stand,
} from "./helpers";

const OFFICE = "agentcorp-observer";

test("the first message scan reads only the head of the history and fails closed", async t => {
  const root = await temporary(t);
  const file = join(root, "events.jsonl");
  assert.deepEqual(await firstMessage(file), { status: "none" });
  await writeFile(file, "");
  assert.deepEqual(await firstMessage(file), { status: "none" });
  await writeFile(file, lines(ev("session.start")));
  assert.deepEqual(await firstMessage(file), { status: "none" });
  await writeFile(file, lines(
    ev("session.start"),
    ev("user.message", userMessage({ content: "From a helper." }), 10, { agentId: HELPER }),
    ev("user.message", userMessage({ content: "Root.", transformedContent: "Root, transformed." }), 20),
    ev("user.message", userMessage({ content: "Later." }), 30),
  ));
  assert.deepEqual(await firstMessage(file), { status: "found", message: { content: "Root.", transformedContent: "Root, transformed." } });
  const tail = JSON.stringify(ev("user.message", userMessage({ content: "Tail." })));
  await writeFile(file, lines(ev("session.start")) + tail);
  assert.deepEqual(await firstMessage(file), { status: "found", message: { content: "Tail.", transformedContent: undefined } });
  await writeFile(file, lines(ev("session.start")) + tail.slice(0, 40));
  assert.deepEqual(await firstMessage(file, { retries: 1, retryMs: 1 }), { status: "unknown", reason: "partial" });
  await writeFile(file, "hello world\n");
  assert.deepEqual(await firstMessage(file), { status: "unknown", reason: "format" });
  const later = lines(ev("user.message", userMessage({ content: "Later." }), 30));
  for (const garbled of ["not-json\n", "{\"type\":\"user.mes\n", "\n"]) {
    await writeFile(file, lines(ev("session.start")) + garbled + later);
    assert.deepEqual(await firstMessage(file), { status: "unknown", reason: "format" }, JSON.stringify(garbled));
  }
  await writeFile(file, lines(ev("session.start")) + "not-json");
  assert.deepEqual(await firstMessage(file), { status: "unknown", reason: "format" });
  await writeFile(file, "{\"type\":\"user.message\",nope}\n");
  assert.deepEqual(await firstMessage(file), { status: "unknown", reason: "parse" });
  await writeFile(file, lines({ type: "user.message", data: "text" }));
  assert.deepEqual(await firstMessage(file), { status: "unknown", reason: "format" });
  const textless: Array<[unknown, string?]> = [
    [{}], [{ content: { text: "Hidden." } }], [{ transformedContent: "Only transformed." }],
    [{ content: "Shown.", transformedContent: ["Hidden."] }], [{}, HELPER],
  ];
  for (const [data, agentId] of textless) {
    await writeFile(file, lines(ev("session.start"), ev("user.message", data, 20, { agentId })));
    assert.deepEqual(await firstMessage(file), { status: "unknown", reason: "format" }, JSON.stringify({ data, agentId }));
  }
  const link = join(root, "linked.jsonl");
  await symlink(file, link);
  assert.deepEqual(await firstMessage(link), { status: "unknown", reason: "ELOOP" });
});

test("the first message scan fails closed on a prompt line whose separator is damaged", async t => {
  const root = await temporary(t);
  const file = join(root, "events.jsonl");
  const start = lines(ev("session.start"));
  const later = lines(ev("user.message", userMessage({ content: "Later." }), 30));
  const damaged = JSON.stringify(ev("user.message", userMessage({ content: "Damaged." }), 20)).replace("\"user.message\",", "\"user.message\" ,");
  await writeFile(file, `${start}${damaged}\n${later}`);
  assert.deepEqual(await firstMessage(file), { status: "unknown", reason: "format" });
  await writeFile(file, start + damaged);
  assert.deepEqual(await firstMessage(file), { status: "unknown", reason: "format" });
  await writeFile(file, start + lines(ev("user.message_sent", userMessage({ content: "Another event." }), 20)) + later);
  assert.deepEqual(await firstMessage(file), { status: "found", message: { content: "Later.", transformedContent: undefined } });
});

test("the first message scan finds a prompt after a long history, across read boundaries", async t => {
  const root = await temporary(t);
  const file = join(root, "events.jsonl");
  const start = lines(ev("session.start"));
  const message = lines(ev("user.message", userMessage({ content: "After a long history." }), 20));
  const empty = lines(ev("system.message", { content: "" }, 10));
  const messageAt = 2 * 1024 * 1024 - 30;
  const filler = lines(ev("system.message", { content: "x".repeat(messageAt - Buffer.byteLength(start) - Buffer.byteLength(empty)) }, 10));
  assert.equal(Buffer.byteLength(start + filler), messageAt);
  await writeFile(file, start + filler + message);
  assert.deepEqual(await firstMessage(file), { status: "found", message: { content: "After a long history.", transformedContent: undefined } });
});

test("a top-level session publishes a private record and keeps it current", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Please fix the flaky test."));
  const meta: Record<string, unknown> = { summary: "Weekly planning", currentMode: "plan" };
  const bag: Bag = {};
  const { publisher, reports } = publisherFor(t, office, sessionId);
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata(meta, bag) });
  const path = await recordOf(office, sessionId);
  const record = await readJson(path);
  assert.deepEqual(
    pick(record, ["version", "sessionId", "title", "mode", "state", "activity", "kind"]),
    { version: 1, sessionId, title: "Weekly planning", mode: "plan", state: "idle", activity: WORDS.idle, kind: null },
  );
  assert.match(record.owner, /^[0-9a-f]{32}$/);
  assert.equal(basename(path), `${sessionId}.${record.owner}.json`);
  assert.ok(Date.parse(record.since) <= Date.parse(record.updatedAt));
  assert.equal(await permissions(office), 0o700);
  assert.equal(await permissions(join(office, "presence")), 0o700);
  assert.equal(await permissions(path), 0o600);

  publisher.onEvent(live("user.message", userMessage({ content: "Go on." })));
  publisher.onEvent(live("tool.execution_start", { toolName: "bash", toolCallId: "c1" }));
  await eventually(async () => assert.deepEqual(
    pick(await readJson(path), ["state", "activity", "kind"]),
    { state: "working", activity: toolWords("bash"), kind: "terminal" },
  ));
  const settled = await readJson(path);
  publisher.onEvent(live("tool.execution_progress", { toolCallId: "c1", progressMessage: "Still going." }));
  await sleep(60);
  assert.equal((await readJson(path)).updatedAt, settled.updatedAt);

  meta.currentMode = "autopilot";
  publisher.onEvent(live("session.mode_changed", { previousMode: "plan", newMode: "autopilot" }));
  await eventually(async () => assert.equal((await readJson(path)).mode, "autopilot"));
  meta.currentMode = "interactive";
  publisher.onEvent(live("session.title_changed", { title: "Ship the\nbilling fix" }));
  await eventually(async () => assert.deepEqual(pick(await readJson(path), ["title", "mode"]), { title: "Ship the billing fix", mode: "interactive" }));
  await eventually(async () => assert.deepEqual(bag, { [MEMORY_KEY]: "Ship the billing fix" }));
  assert.deepEqual(await readdir(office), ["presence"]);
  assert.deepEqual(await readdir(join(office, "presence")), [basename(path)]);

  publisher.onEvent(live("session.shutdown", { shutdownType: "routine" }));
  assert.equal(await exists(path), false);
  publisher.onEvent(live("user.message", userMessage({ content: "After shutdown." })));
  await sleep(30);
  assert.equal(await exists(path), false);
  assert.deepEqual(reports, []);
});

test("heartbeats keep a quiet session fresh", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Watch the build."));
  const { publisher, reports } = publisherFor(t, office, sessionId, { heartbeatMs: 40 });
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ currentMode: "interactive" }) });
  const first = (await readRecord(office, sessionId)).updatedAt;
  await eventually(async () => assert.ok(Date.parse((await readRecord(office, sessionId)).updatedAt) > Date.parse(first)));
  assert.deepEqual(reports, []);
});

test("each running copy of a session keeps its own record, and the roster shows the session once", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Keep going."));
  const metadata = rpcMetadata({ summary: "Shared work", currentMode: "interactive" });
  const older = publisherFor(t, office, sessionId).publisher;
  await older.start({ workspacePath: folder, metadata });
  older.onEvent({ ...live("session.shutdown"), timestamp: new Date(Date.now() - 60_000).toISOString() });
  const olderPath = await recordOf(office, sessionId);
  const newer = publisherFor(t, office, sessionId).publisher;
  await newer.start({ workspacePath: folder, metadata });
  assert.equal((await recordFiles(office, sessionId)).length, 2);
  assert.deepEqual((await readRoster(office)).agents.map(agent => agent.title), ["Shared work"]);
  await older.stop();
  assert.equal(await exists(olderPath), false);
  assert.notEqual(await recordOf(office, sessionId), olderPath);
  assert.deepEqual((await readRoster(office)).agents.map(agent => agent.title), ["Shared work"]);
});

test("a shutdown during a write still removes the record", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Keep going."));
  const { publisher, reports } = publisherFor(t, office, sessionId);
  let stopping = null as Promise<void> | null;
  patchFs(t, "rename", real => async (from, to) => {
    if (!stopping && dirname(String(to)) === join(office, "presence")) stopping = publisher.stop();
    return real(from, to);
  });
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ currentMode: "interactive" }) });
  assert.ok(stopping);
  await stopping;
  assert.deepEqual(await readdir(join(office, "presence")), []);
  assert.deepEqual(reports, []);
});

test("a title from an event survives a quick stop and an extension reload", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Plan the release."));
  const bag: Bag = {};
  const stand = rpcMetadata({ currentMode: "interactive" }, bag);
  const slow: Stand = { ...stand, updateClientMetadata: async patch => { await sleep(50); return stand.updateClientMetadata(patch); } };
  const first = publisherFor(t, office, sessionId, { coalesceMs: 1000 }).publisher;
  await first.start({ workspacePath: folder, metadata: slow });
  first.onEvent(live("session.title_changed", { title: "Renamed by the agent" }));
  await first.stop();
  assert.equal(await hasRecord(office, sessionId), false);
  assert.deepEqual(bag, { [MEMORY_KEY]: "Renamed by the agent" });
  const second = publisherFor(t, office, sessionId).publisher;
  await second.start({ workspacePath: folder, metadata: rpcMetadata({ currentMode: "interactive" }, bag) });
  assert.equal((await readRecord(office, sessionId)).title, "Renamed by the agent");
});

test("titles stay safe and visible while the session cannot read or save them, and catch up once it can", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Plan the release."));
  const bag: Bag = { [MEMORY_KEY]: "Earlier title" };
  const stand = rpcMetadata({ summary: "Release work", currentMode: "interactive" }, bag);
  const failing = { read: true, save: false };
  const busy = <A extends unknown[], R>(kind: keyof typeof failing, work: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    if (failing[kind]) throw new Error("Runtime busy.");
    return work(...args);
  };
  const flaky: Stand = { ...stand, getClientMetadata: busy("read", stand.getClientMetadata), updateClientMetadata: busy("save", stand.updateClientMetadata) };
  const { publisher, reports } = publisherFor(t, office, sessionId, { heartbeatMs: 30 });
  await publisher.start({ workspacePath: folder, metadata: flaky });
  const path = await recordOf(office, sessionId);
  assert.equal((await readJson(path)).title, "Release work");
  await sleep(150);
  assert.deepEqual(bag, { [MEMORY_KEY]: "Earlier title" });

  failing.read = false;
  await eventually(async () => assert.equal((await readJson(path)).title, "Earlier title"));

  failing.save = true;
  publisher.onEvent(live("session.title_changed", { title: "Live title" }));
  await eventually(async () => assert.equal((await readJson(path)).title, "Live title"));
  failing.save = false;
  await eventually(async () => assert.deepEqual(bag, { [MEMORY_KEY]: "Live title" }));
  assert.deepEqual(reports, [["title", "Runtime busy."]]);
});

test("a saved title that loads slowly delays the first record only briefly, and shows once it arrives", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Plan the release."));
  const stand = rpcMetadata({ summary: "Release work", currentMode: "interactive" }, { [MEMORY_KEY]: "Earlier title" });
  let release = null as (() => void) | null;
  const slow: Stand = {
    ...stand,
    getClientMetadata: () => new Promise(resolve => { release = () => resolve(stand.getClientMetadata()); }),
  };
  const { publisher, reports } = publisherFor(t, office, sessionId);
  cleanUp(t, () => release?.());
  await publisher.start({ workspacePath: folder, metadata: slow });
  const path = await recordOf(office, sessionId);
  assert.equal((await readJson(path)).title, "Release work");
  assert.ok(release);
  release();
  await eventually(async () => assert.equal((await readJson(path)).title, "Earlier title"));
  assert.deepEqual(reports, []);
});

test("without client metadata, titles still show and the session says why once", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Plan the release."));
  const { publisher, reports } = publisherFor(t, office, sessionId);
  await publisher.start({ workspacePath: folder, metadata: { snapshot: rpcMetadata({ currentMode: "interactive" }).snapshot } });
  publisher.onEvent(live("session.title_changed", { title: "Unsaved title" }));
  publisher.onEvent(live("session.title_changed", { title: "Another title" }));
  await eventually(async () => assert.equal((await readRecord(office, sessionId)).title, "Another title"));
  assert.deepEqual(reports.map(([kind]) => kind), ["title"]);
});

test("a title that repeats the first prompt is neither shown nor remembered", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Please plan the quarterly release for the payments team."));
  const bag: Bag = { [MEMORY_KEY]: "Please plan the quarterly release" };
  const { publisher, reports } = publisherFor(t, office, sessionId);
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ summary: "Quarterly release", currentMode: "interactive" }, bag) });
  const path = await recordOf(office, sessionId);
  assert.equal((await readJson(path)).title, "Quarterly release");
  assert.deepEqual(bag, {});

  publisher.onEvent(live("session.title_changed", { title: "Please plan the quarterly release" }));
  publisher.onEvent(live("user.message", userMessage({ content: "Go on." })));
  await eventually(async () => assert.equal((await readJson(path)).state, "working"));
  assert.equal((await readJson(path)).title, "Quarterly release");
  assert.deepEqual(bag, {});

  publisher.onEvent(live("session.title_changed", { title: "Release plan" }));
  await eventually(async () => assert.deepEqual(bag, { [MEMORY_KEY]: "Release plan" }));
  await eventually(async () => assert.equal((await readJson(path)).title, "Release plan"));

  publisher.onEvent(live("session.title_changed", { title: "Quarterly release for the payments team" }));
  await eventually(async () => assert.deepEqual(bag, {}));
  await eventually(async () => assert.equal((await readJson(path)).title, "Quarterly release"));
  assert.deepEqual(reports, []);
});

test("a heartbeat snapshot that answers late cannot bring back a renamed session's old name", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Plan the release."));
  const named = (name: string) => ({ currentMode: "interactive", workspace: { name, user_named: true } });
  const stand = rpcMetadata(named("Old name"));
  const held: Array<(value: unknown) => void> = [];
  let hold = false;
  const slow: Stand = { ...stand, snapshot: () => hold ? new Promise(resolve => { held.push(resolve); }) : stand.snapshot() };
  cleanUp(t, () => { for (const resolve of held) resolve(named("Old name")); });
  const { publisher, reports } = publisherFor(t, office, sessionId, { heartbeatMs: 30 });
  await publisher.start({ workspacePath: folder, metadata: slow });
  const path = await recordOf(office, sessionId);
  assert.equal((await readJson(path)).title, "Old name");

  hold = true;
  await eventually(() => assert.ok(held.length > 0));
  publisher.onEvent(live("session.title_changed", { title: "New name" }));
  const older = held.slice(0, -1);
  held.at(-1)?.(named("New name"));
  await eventually(async () => assert.equal((await readJson(path)).title, "New name"));
  for (const resolve of older) resolve(named("Old name"));
  await sleep(100);
  assert.equal((await readJson(path)).title, "New name");
  assert.deepEqual(reports, []);
});

test("a session without a prompt yet appears once its first root prompt arrives", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, null);
  const { publisher, reports } = publisherFor(t, office, sessionId);
  const starting = publisher.start({ workspacePath: folder, metadata: rpcMetadata({ summary: "New work", currentMode: "interactive" }) });
  await sleep(50);
  publisher.onEvent(live("user.message", userMessage({ content: "From a helper." }), { agentId: HELPER }));
  await sleep(50);
  assert.equal(await hasRecord(office, sessionId), false);
  publisher.onEvent(live("user.message", userMessage(topLevel("Start here."))));
  await starting;
  assert.deepEqual(pick(await readRecord(office, sessionId), ["title", "state", "kind"]), { title: "New work", state: "working", kind: "thinking" });
  assert.deepEqual(reports, []);
});

test("a session whose history turns unreadable before its first prompt stays hidden", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, null);
  const history = join(folder, "events.jsonl");
  let reads = 0;
  patchFs(t, "open", real => (async (...args: Parameters<typeof real>) => {
    if (String(args[0]) === history && ++reads === 2) await appendFile(history, "not an event\n");
    return real(...args);
  }) as typeof real);
  const { publisher, reports } = publisherFor(t, office, sessionId);
  const starting = publisher.start({ workspacePath: folder, metadata: rpcMetadata({ summary: "New work", currentMode: "interactive" }) });
  publisher.onEvent(live("user.message", userMessage(topLevel("Start here."))));
  await starting;
  assert.equal(reads, 2);
  assert.equal(await exists(office), false);
  assert.deepEqual(reports.map(([kind]) => kind), ["start"]);
});

test("a session whose first prompt has no text stays hidden, whether saved or live", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const saved = await sessionFolder(root, id(1), null);
  await appendFile(join(saved, "events.jsonl"), lines(ev("user.message", {}, 1000)));
  const first = publisherFor(t, office, id(1));
  await first.publisher.start({ workspacePath: saved, metadata: rpcMetadata({ summary: "New work", currentMode: "interactive" }) });
  const fresh = await sessionFolder(root, id(2), null);
  const second = publisherFor(t, office, id(2));
  const starting = second.publisher.start({ workspacePath: fresh, metadata: rpcMetadata({ summary: "New work", currentMode: "interactive" }) });
  await sleep(50);
  second.publisher.onEvent(live("user.message", { content: { text: "Start here." } }));
  second.publisher.onEvent(live("user.message", userMessage(topLevel("Start here."))));
  await starting;
  assert.equal(await exists(office), false);
  assert.deepEqual([...first.reports, ...second.reports].map(([kind]) => kind), ["start", "start"]);
});

test("a session that another session started never publishes", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(2);
  const folder = await sessionFolder(root, sessionId, childOf(id(9)));
  const { publisher, reports } = publisherFor(t, office, sessionId, { heartbeatMs: 20 });
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ summary: "Child work", currentMode: "autopilot" }) });
  publisher.onEvent(live("user.message", userMessage({ content: "More." })));
  publisher.onEvent(live("tool.execution_start", { toolName: "bash", toolCallId: "c1" }));
  await sleep(100);
  assert.equal(await exists(office), false);
  assert.deepEqual(reports, []);
});

test("sessions that My Copilot started appear, and My Copilot itself drops out", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const shown = async () => (await readRoster(office)).agents.map(agent => agent.title);
  const begin = async (sessionId: string, message: Parameters<typeof sessionFolder>[2], summary: string, options?: { heartbeatMs?: number }) => {
    const folder = await sessionFolder(root, sessionId, message);
    const { publisher, reports } = publisherFor(t, office, sessionId, options);
    await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ summary, currentMode: "interactive" }) });
    return reports;
  };
  const myCopilot = id(7);
  const renamed = () => childOf(myCopilot, crossBlock({ from: myCopilot, name: "Renamed assistant" }));
  const reports = [
    await begin(myCopilot, topLevel("Check my pull requests."), "Assistant chat"),
  ];
  assert.deepEqual(await shown(), ["Assistant chat"]);
  reports.push(await begin(id(4), renamed(), "Early sibling", { heartbeatMs: 20 }));
  assert.equal(await hasRecord(office, id(4)), false);
  reports.push(await begin(id(3), myCopilotChild(myCopilot), "Named child"));
  const marker = join(office, "my-copilot", myCopilot);
  assert.equal((await lstat(marker)).size, 0);
  assert.equal(await permissions(marker), 0o600);
  assert.equal(await permissions(join(office, "my-copilot")), 0o700);
  assert.equal(await hasRecord(office, myCopilot), true);
  await eventually(async () => assert.deepEqual(await shown(), ["Early sibling", "Named child"]));
  reports.push(await begin(id(6), renamed(), "Late sibling"));
  reports.push(await begin(id(5), childOf(id(9)), "Other child"));
  assert.deepEqual(await shown(), ["Early sibling", "Late sibling", "Named child"]);
  assert.equal(await hasRecord(office, id(5)), false);
  assert.deepEqual(reports.flat(), []);
});

test("a child whose creator is known to be My Copilot appears even when another session sent its task", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "my-copilot");
  const myCopilot = id(7);
  const sender = id(8);
  const sessionId = id(3);
  const folder = await sessionFolder(root, sessionId, childOf(myCopilot, crossBlock({ from: sender, project: sender })));
  const { publisher, reports } = publisherFor(t, office, sessionId, { heartbeatMs: 20 });
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ summary: "Handed over", currentMode: "interactive" }) });
  await sleep(100);
  assert.equal(await hasRecord(office, sessionId), false);
  await writeFile(join(office, "my-copilot", myCopilot), "", { mode: 0o600 });
  await eventually(async () => assert.deepEqual((await readRoster(office)).agents.map(agent => agent.title), ["Handed over"]));
  assert.equal(await exists(join(office, "my-copilot", sender)), false);
  assert.deepEqual(reports, []);
});

test("a marker that can't be read at startup keeps a child hidden until a later check reads it", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "my-copilot");
  const myCopilot = id(7);
  const marker = join(office, "my-copilot", myCopilot);
  await writeFile(marker, "", { mode: 0o600 });
  let broken = true;
  patchFs(t, "lstat", real => (async (path: PathLike, options?: StatOptions) => {
    if (broken && String(path) === marker) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    return real(path, options);
  }) as typeof real);
  const sessionId = id(3);
  const folder = await sessionFolder(root, sessionId, childOf(myCopilot));
  const { publisher, reports } = publisherFor(t, office, sessionId, { heartbeatMs: 20 });
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ summary: "Waited child", currentMode: "interactive" }) });
  await sleep(100);
  assert.equal(await hasRecord(office, sessionId), false);
  broken = false;
  await eventually(async () => assert.deepEqual((await readRoster(office)).agents.map(agent => agent.title), ["Waited child"]));
  assert.deepEqual(reports, [["markers", "EIO: i/o error"], ["recheck", "EIO: i/o error"]]);
});

test("a child shown only because its creator is known drops out when that marker expires", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "my-copilot");
  const myCopilot = id(7);
  const marker = join(office, "my-copilot", myCopilot);
  await writeFile(marker, "", { mode: 0o600 });
  const sessionId = id(3);
  const folder = await sessionFolder(root, sessionId, childOf(myCopilot, crossBlock({ from: myCopilot, name: "Renamed assistant" })));
  const { publisher, reports } = publisherFor(t, office, sessionId, { heartbeatMs: 20 });
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ summary: "Renamed child", currentMode: "interactive" }) });
  const titles = async () => (await readRoster(office)).agents.map(agent => agent.title);
  assert.deepEqual(await titles(), ["Renamed child"]);
  const expired = new Date(Date.now() - 31 * DAY);
  await utimes(marker, expired, expired);
  await eventually(async () => assert.equal(await hasRecord(office, sessionId), false));
  await sleep(100);
  assert.equal(await hasRecord(office, sessionId), false);
  await utimes(marker, new Date(), new Date());
  await eventually(async () => assert.deepEqual(await titles(), ["Renamed child"]));
  assert.equal(await exists(marker), true);
  assert.deepEqual(reports, []);
});

test("a My Copilot marker that another copy just created counts as remembered", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const myCopilot = id(7);
  const marker = join(office, "my-copilot", myCopilot);
  patchFs(t, "open", real => async (path, flags, mode) => {
    if (path === marker && flags === "wx") await writeFile(path, "", { mode: 0o600 });
    return real(path, flags, mode);
  });
  const sessionId = id(3);
  const folder = await sessionFolder(root, sessionId, myCopilotChild(myCopilot));
  const { publisher, reports } = publisherFor(t, office, sessionId);
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ summary: "Named child", currentMode: "interactive" }) });
  assert.equal(await exists(marker), true);
  assert.deepEqual((await readRoster(office)).agents.map(agent => agent.title), ["Named child"]);
  assert.deepEqual(reports, []);
});

test("a permission request appears only after its grace period", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Deploy it."));
  const { publisher } = publisherFor(t, office, sessionId);
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ currentMode: "interactive" }) });
  const path = await recordOf(office, sessionId);
  publisher.onEvent(live("user.message", userMessage({ content: "Deploy it." })));
  publisher.onEvent(live("permission.requested", { requestId: "p1", resolvedByHook: false }));
  await sleep(200);
  assert.equal((await readJson(path)).state, "working");
  await eventually(async () => assert.deepEqual(
    pick(await readJson(path), ["state", "activity", "kind"]),
    { state: "permission", activity: WORDS.permission, kind: null },
  ), { timeout: 5000 });
  publisher.onEvent(live("permission.completed", { requestId: "p1" }));
  await eventually(async () => assert.equal((await readJson(path)).state, "working"));
});

test("a publisher that cannot classify its session stays off and says why", async t => {
  const root = await temporary(t);
  const office = join(root, OFFICE);
  const kinds: string[] = [];
  const invalid = createPublisher({ sessionId: "not-a-session", office, report: kind => { kinds.push(kind); } });
  await invalid.start({ workspacePath: root });
  invalid.onEvent(live("user.message", userMessage(topLevel("Start here."))));
  await invalid.stop();
  assert.deepEqual(kinds, ["setup"]);
  const homeless = publisherFor(t, office, id(1));
  await homeless.publisher.start({ workspacePath: undefined, metadata: rpcMetadata({ currentMode: "interactive" }) });
  const foreign = join(root, "foreign");
  await mkdir(foreign);
  await writeFile(join(foreign, "events.jsonl"), "not a history file\n");
  const unreadable = publisherFor(t, office, id(2));
  await unreadable.publisher.start({ workspacePath: foreign, metadata: rpcMetadata({ currentMode: "interactive" }) });
  for (const { publisher, reports } of [homeless, unreadable]) {
    publisher.onEvent(live("user.message", userMessage(topLevel("Start here."))));
    assert.deepEqual(reports.map(([kind]) => kind), ["start"]);
  }
  await sleep(30);
  assert.equal(await exists(office), false);
});

test("a shown session clears old leftovers, records and markers", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "presence", "my-copilot");
  const now = Date.now();
  const owner = "c".repeat(32);
  const files: Array<[name: string, age: number, kept: boolean]> = [
    [`presence/.${id(20)}.${owner}.json.${owner}.1.tmp`, 2 * HOUR, false],
    [`presence/.${id(21)}.${owner}.json.${owner}.1.tmp`, 0, true],
    [`presence/${id(22)}.${owner}.json`, 2 * HOUR, false],
    [`presence/${id(23)}.${owner}.json`, 0, true],
    ["presence/notes.txt", 40 * DAY, true],
    [`my-copilot/${id(26)}`, 40 * DAY, false],
    [`my-copilot/${id(27)}`, 2 * HOUR, true],
    [`my-copilot/.${id(28)}.${owner}.tmp`, 2 * HOUR, false],
    [`my-copilot/.${id(29)}.${owner}.tmp`, 0, true],
  ];
  for (const [name, age] of files) {
    const path = join(office, name);
    await writeFile(path, "", { mode: 0o600 });
    await utimes(path, new Date(now - age), new Date(now - age));
  }
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Tidy up."));
  const { publisher, reports } = publisherFor(t, office, sessionId);
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ currentMode: "interactive" }) });
  await eventually(async () => {
    for (const [name, , kept] of files) assert.equal(await exists(join(office, name)), kept, name);
  });
  assert.equal(await hasRecord(office, sessionId), true);
  assert.deepEqual(reports, []);
});

test("cleanup keeps a record or marker renewed while it checks them", async t => {
  const root = await temporary(t);
  const office = await officeFolders(root, "presence", "my-copilot");
  const now = Date.now();
  const owner = "d".repeat(32);
  const record = join(office, "presence", `${id(33)}.${owner}.json`);
  const marker = join(office, "my-copilot", id(32));
  const expired = [join(office, "presence", `${id(31)}.${owner}.json`), join(office, "my-copilot", id(30))];
  for (const [path, age] of [[record, 2 * HOUR], [marker, 40 * DAY], [expired[0], 2 * HOUR], [expired[1], 40 * DAY]] as const) {
    await writeFile(path, "", { mode: 0o600 });
    await utimes(path, new Date(now - age), new Date(now - age));
  }
  const renewals = new Map<string, () => Promise<void>>([
    [record, async () => {
      const fresh = join(root, "fresh.json");
      await writeFile(fresh, "renewed", { mode: 0o600 });
      await fsPromises.rename(fresh, record);
    }],
    [marker, () => utimes(marker, new Date(), new Date())],
  ]);
  patchFs(t, "lstat", real => (async (path: PathLike, options?: StatOptions) => {
    const info = await real(path, options);
    const renew = renewals.get(String(path));
    renewals.delete(String(path));
    await renew?.();
    return info;
  }) as typeof real);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Tidy up."));
  const { publisher, reports } = publisherFor(t, office, sessionId);
  await publisher.start({ workspacePath: folder, metadata: rpcMetadata({ currentMode: "interactive" }) });
  await eventually(async () => {
    assert.equal(renewals.size, 0);
    for (const path of expired) assert.equal(await exists(path), false, path);
  });
  await sleep(50);
  await eventually(async () => {
    assert.equal(await readFile(record, "utf8"), "renewed");
    assert.ok(Date.now() - (await lstat(marker)).mtimeMs < HOUR);
    for (const name of ["presence", "my-copilot"]) {
      assert.deepEqual((await readdir(join(office, name))).filter(entry => entry.endsWith(".tmp")), []);
    }
  });
  assert.deepEqual(reports, []);
});
