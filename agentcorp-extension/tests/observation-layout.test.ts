import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arrangeObservation, initials, needsYou, newAgent, noticeFor, parseObservation, sessionLink, type Member,
} from "../src/observation-layout";
import { agentPersona } from "../src/room";
import { id } from "./helpers";

const member = (memberId: string, state: Member["state"] = "idle", kind: Member["kind"] = null): Member => ({
  id: memberId, title: `Session ${memberId}`, mode: "interactive", state,
  kind: state === "working" ? kind ?? "thinking" : null,
  activity: "Doing something", since: "2026-01-01T09:00:00.000Z", url: `ghapp://sessions/${id(1)}`,
});
const snapshot = (sessions: Member[], extra: Record<string, unknown> = {}) => ({
  root: id(1), sessions, overflow: 0, counts: { needsYou: 0, error: 0, working: 0, idle: sessions.length }, ...extra,
});

test("activity priority may reorder rows without swapping scene agents or their personas", () => {
  const previous = [member("alpha"), member("beta", "working", "terminal")];
  const agents = [newAgent(0), newAgent(1)];
  agents[0].x = 2;
  agents[1].x = -4;
  const arranged = arrangeObservation(previous, agents, [
    member("beta", "question"), member("alpha", "working"),
  ]);
  assert.deepEqual(arranged.members, [member("alpha", "working"), member("beta", "question")]);
  assert.strictEqual(arranged.agents[0], agents[0]);
  assert.strictEqual(arranged.agents[1], agents[1]);
  assert.equal(arranged.agents[0].x, 2);
  assert.equal(arranged.agents[1].x, -4);
  assert.equal(agentPersona(arranged.members[0].id), agentPersona(previous[0].id));
  assert.equal(agentPersona(arranged.members[1].id), agentPersona(previous[1].id));
});

test("a removed desk compacts without losing the surviving agent's identity", () => {
  const previous = [member("alpha"), member("beta"), member("gamma")];
  const agents = [newAgent(0), newAgent(1), newAgent(2)];
  agents[2].x = 6;
  const arranged = arrangeObservation(previous, agents, [
    member("delta", "working", "editing"), member("gamma", "working"), member("alpha"),
  ]);
  assert.deepEqual(arranged.members.map(({ id: memberId }) => memberId), ["alpha", "gamma", "delta"]);
  assert.strictEqual(arranged.agents[0], agents[0]);
  assert.strictEqual(arranged.agents[1], agents[2]);
  assert.equal(arranged.agents[1].id, 1);
  assert.equal(arranged.agents[1].x, 6);
  assert.equal(arranged.agents[2].x, 100);
  assert.notStrictEqual(arranged.agents[2], agents[1]);
  assert.equal(arranged.members.findIndex(({ id: memberId }) => memberId === "gamma") + 1, 2);
});

test("a selected session displaced from the visible top 16 is no longer focusable", () => {
  const previous = Array.from({ length: 16 }, (_, index) => member(`idle-${index}`));
  const agents = previous.map((_, index) => newAgent(index));
  const incoming = [member("urgent", "permission"), ...previous.slice(0, 15)];
  const arranged = arrangeObservation(previous, agents, incoming);
  assert.equal(arranged.members.length, 16);
  assert.equal(arranged.members.findIndex(({ id: memberId }) => memberId === "idle-15"), -1);
  assert.equal(arranged.members.findIndex(({ id: memberId }) => memberId === "urgent"), 15);
  assert.strictEqual(arranged.agents[0], agents[0]);
  assert.notStrictEqual(arranged.agents[15], agents[15]);
});

test("duplicate session IDs fail rather than silently merging agents", () => {
  assert.throws(() => arrangeObservation([], [], [
    member("same", "idle"), member("same", "working"),
  ]), /Duplicate observed session ID/);
});

test("a well-formed snapshot passes through unchanged", () => {
  const value = snapshot([member("alpha", "working", "research"), member("beta", "plan-ready")],
    { overflow: 3, counts: { needsYou: 1, error: 0, working: 1, idle: 3 } });
  assert.deepEqual(parseObservation(structuredClone(value)), value);
  assert.deepEqual(parseObservation(snapshot([{ ...member("gamma"), mode: null }])).sessions[0].mode, null);
});

test("snapshots with unknown values, inherited names or impossible counts are rejected", () => {
  const broken: unknown[] = [
    null,
    snapshot([{ ...member("alpha"), state: "sleeping" } as unknown as Member]),
    snapshot([{ ...member("alpha"), state: "toString" } as unknown as Member]),
    snapshot([{ ...member("alpha"), mode: "turbo" } as unknown as Member]),
    snapshot([{ ...member("alpha", "working"), kind: "constructor" } as unknown as Member]),
    snapshot([{ ...member("alpha"), title: 7 } as unknown as Member]),
    snapshot([{ ...member("alpha"), url: undefined } as unknown as Member]),
    snapshot(Array.from({ length: 17 }, (_, index) => member(`desk-${index}`))),
    snapshot([], { overflow: -1 }),
    snapshot([], { overflow: 1.5 }),
    snapshot([], { counts: { needsYou: 0, error: 0, working: 0 } }),
    snapshot([], { counts: null }),
    snapshot([], { sessions: {} }),
  ];
  for (const value of broken) assert.throws(() => parseObservation(value), /Invalid office snapshot/);
});

test("each state maps to its scene notice and only waiting states need you", () => {
  const cases: Array<[Member, string | null, boolean]> = [
    [member("a", "idle"), null, false],
    [member("b", "working"), "thinking", false],
    [member("c", "working", "terminal"), "terminal", false],
    [member("d", "question"), "question", true],
    [member("e", "permission"), "blocked", true],
    [member("f", "plan-ready"), "plan", true],
    [member("g", "error"), "error", false],
  ];
  for (const [value, notice, waiting] of cases) {
    assert.equal(noticeFor(value), notice, value.state);
    assert.equal(needsYou(value), waiting, value.state);
  }
});

test("only app session links for a well-formed session ID can be opened", () => {
  const good = `ghapp://sessions/${id(42)}`;
  assert.equal(sessionLink(good), good);
  for (const url of [
    "", `https://sessions/${id(42)}`, `ghapp://sessions/${id(42)}/extra`, `ghapp://sessions/${id(42)}?x=1`,
    "ghapp://sessions/not-a-session", `ghapp://settings/${id(42)}`, `javascript:ghapp://sessions/${id(42)}`,
  ]) assert.equal(sessionLink(url), null, url);
});

test("avatar initials come from the first two words of the title", () => {
  assert.equal(initials("fix flaky login test"), "FF");
  assert.equal(initials("  Deploy  "), "D");
  assert.equal(initials(""), "?");
  assert.equal(initials("   "), "?");
});
