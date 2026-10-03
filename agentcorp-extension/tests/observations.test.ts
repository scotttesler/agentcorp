import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DESKS, snapshot } from "../../.github/extensions/agentcorp-extension/observations.mjs";
import { STALE_MS } from "../../.github/extensions/agentcorp-extension/presence.mjs";
import { id, officeFolders, putRecord, validRecord, type StoredRecord } from "./helpers";

const home = await realpath(await mkdtemp(join(tmpdir(), "agentcorp-observations-")));
process.env.COPILOT_HOME = home;
const office = join(home, "agentcorp-observer");
const now = Date.parse("2026-01-01T09:00:00.000Z");
const nobody = { needsYou: 0, error: 0, working: 0, idle: 0 };

async function officeWith(...records: StoredRecord[]) {
  await officeFolders(home, "presence");
  for (const record of records) await putRecord(office, record);
}

test.beforeEach(async () => { await rm(office, { recursive: true, force: true }); });
test.after(async () => { await rm(home, { recursive: true, force: true }); });

test("an office nobody has joined is empty, and the opening session needs a valid ID", async () => {
  assert.deepEqual(await snapshot("root", now), { root: "root", sessions: [], overflow: 0, counts: nobody });
  await assert.rejects(snapshot("../escape", now), /Invalid session ID/);
});

test("each session carries only what the office draws", async () => {
  await officeWith(validRecord(id(1), now, {
    title: "Fix the build", mode: "autopilot", state: "working", kind: "terminal", activity: "Running a command", prompt: "private-prompt",
  }));
  assert.deepEqual(await snapshot("root", now), {
    root: "root",
    sessions: [{
      id: id(1), title: "Fix the build", mode: "autopilot", state: "working", kind: "terminal", activity: "Running a command",
      since: new Date(now - 60_000).toISOString(), url: `ghapp://sessions/${id(1)}`,
    }],
    overflow: 0,
    counts: { ...nobody, working: 1 },
  });
});

test("sessions that need you come first, the first 16 get desks, and the counts include everyone", async () => {
  const states = [...Array(8).fill("idle"), ...Array(9).fill("working"), "error", "question", "permission"];
  await officeWith(...states.map((state, index) => validRecord(id(index + 1), now, {
    state, title: `Agent ${String(index + 1).padStart(2, "0")}`, since: new Date(now - (index + 1) * 1000).toISOString(),
  })));
  const observed = await snapshot("root", now);
  assert.equal(MAX_DESKS, 16);
  assert.deepEqual(observed.sessions.map(session => session.id), [
    id(20), id(19), id(18), ...Array.from({ length: 9 }, (_, index) => id(index + 9)), id(1), id(2), id(3), id(4),
  ]);
  assert.equal(observed.overflow, 4);
  assert.deepEqual(observed.counts, { needsYou: 2, error: 1, working: 9, idle: 8 });
});

test("a session drops out once its record goes stale at the time asked", async () => {
  await officeWith(validRecord(id(1), now));
  assert.deepEqual((await snapshot("root", now)).sessions.map(session => session.id), [id(1)]);
  assert.deepEqual(await snapshot("root", now - 1000 + STALE_MS + 1), { root: "root", sessions: [], overflow: 0, counts: nobody });
});

test("an office folder that can't be trusted fails instead of looking empty", async () => {
  await writeFile(office, "not a folder");
  await assert.rejects(snapshot("root", now));
  await rm(office);
  await mkdir(office);
  await chmod(office, 0o755);
  await assert.rejects(snapshot("root", now));
});

test("files from older observer versions stay untouched and unseen", async () => {
  await officeWith(validRecord(id(1), now, { title: "Current" }));
  const older = join(home, "extensions", "agentcorp-observer", "artifacts");
  const previous = join(office, "artifacts");
  await mkdir(older, { recursive: true });
  await mkdir(previous, { mode: 0o700 });
  const beat = JSON.stringify({ id: "old", phase: "tool", owner: "old-owner", at: now });
  for (const folder of [older, previous]) await writeFile(join(folder, "heartbeat-old.json"), beat);
  await writeFile(join(previous, "root-root.json"), "{obsolete graph");
  assert.deepEqual((await snapshot("root", now)).sessions.map(session => session.id), [id(1)]);
  for (const folder of [older, previous]) assert.equal(await readFile(join(folder, "heartbeat-old.json"), "utf8"), beat);
  assert.equal(await readFile(join(previous, "root-root.json"), "utf8"), "{obsolete graph");
});
