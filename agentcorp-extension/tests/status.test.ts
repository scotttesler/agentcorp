import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KINDS, PERMISSION_GRACE_MS, WORDS, clean, creatorOf, initialState, madeUpName, promptPrint, reduce, resolveTitle, toolKind, toolWords, view,
  type Snapshot,
} from "../../.github/extensions/agentcorp-extension/status.mjs";
import {
  HELPER, PREAMBLE, LETTERED, T0, childOf, crossBlock, ev, id, myCopilotChild, pick, startedInWorkspace, step, topLevel, workspaceBlock,
} from "./helpers";

test("a turn moves the agent from idle to working and names what it is doing", () => {
  let state = initialState(T0);
  assert.deepEqual(view(state, T0), { state: "idle", since: T0, activity: WORDS.idle, kind: null, nextChange: null });
  state = step(state, "user.message", { content: "Fix the build." }, 1000);
  assert.deepEqual(view(state, T0 + 1000), { state: "working", since: T0 + 1000, activity: WORDS.working, kind: "thinking", nextChange: null });
  const doing = (ms: number) => pick(view(state, T0 + ms), ["activity", "kind"]);
  state = step(state, "tool.execution_start", { toolName: "bash", toolCallId: "c1" }, 2000);
  assert.deepEqual(doing(2000), { activity: toolWords("bash"), kind: "terminal" });
  state = step(state, "tool.execution_start", { toolName: "report_intent", toolCallId: "c2" }, 2100);
  assert.deepEqual(doing(2100), { activity: toolWords("bash"), kind: "terminal" });
  state = step(state, "tool.execution_start", { toolName: "view", toolCallId: "c3" }, 2200);
  assert.deepEqual(doing(2200), { activity: toolWords("view"), kind: "research" });
  state = step(state, "tool.execution_complete", { toolCallId: "c3", success: true }, 2300);
  assert.deepEqual(doing(2300), { activity: toolWords("bash"), kind: "terminal" });
  state = step(state, "assistant.intent", { intent: "Fixing\nthe   build" }, 2400);
  assert.deepEqual(doing(2400), { activity: "Fixing the build", kind: "terminal" });
  state = step(state, "assistant.idle", {}, 2500);
  assert.deepEqual(view(state, T0 + 2500), { state: "working", since: T0 + 1000, activity: WORDS.working, kind: "thinking", nextChange: null });
  state = step(state, "subagent.started", { toolCallId: "s1", agentName: "explore" }, 2600, { agentId: HELPER });
  assert.deepEqual(doing(2600), { activity: toolWords("task"), kind: "delegating" });
  state = step(state, "subagent.completed", { toolCallId: "s1" }, 2700, { agentId: HELPER });
  assert.deepEqual(doing(2700), { activity: WORDS.working, kind: "thinking" });
  state = step(state, "session.idle", {}, 3000);
  assert.deepEqual(view(state, T0 + 3000), { state: "idle", since: T0 + 3000, activity: WORDS.idle, kind: null, nextChange: null });
});

test("helper agent events, unknown events and malformed input leave the state alone", () => {
  const state = step(step(initialState(T0), "user.message", {}, 0), "user_input.requested", { requestId: "q1", question: "Which one?" }, 5);
  const ignored: unknown[] = [
    ev("tool.execution_start", { toolName: "bash", toolCallId: "x" }, 10, { agentId: HELPER }),
    ev("session.idle", {}, 10, { agentId: HELPER }),
    ev("user_input.requested", { requestId: "q2", question: "Which file?" }, 10, { agentId: HELPER }),
    ev("elicitation.requested", { requestId: "e1", message: "Pick one" }, 10, { agentId: HELPER }),
    ev("exit_plan_mode.requested", { requestId: "x1" }, 10, { agentId: HELPER }),
    ev("auto_mode_switch.requested", { requestId: "a1" }, 10, { agentId: HELPER }),
    ev("session_limits_exhausted.requested", { requestId: "l1" }, 10, { agentId: HELPER }),
    ev("user_input.completed", { requestId: "q1" }, 10, { agentId: HELPER }),
    ev("session.something_new", {}, 10),
    null,
    {},
    { type: 7 },
    "user.message",
  ];
  for (const event of ignored) assert.equal(reduce(state, event, T0 + 10), state);
  const future = reduce(initialState(T0), ev("user.message", {}, 10 * 60_000), T0 + 5000);
  assert.equal(view(future, T0 + 5000).since, T0 + 5000);
  const undated = reduce(initialState(T0), { type: "user.message", data: {}, timestamp: "soon" }, T0 + 7000);
  assert.equal(view(undated, T0 + 7000).since, T0 + 7000);
});

test("a helper agent keeps its session working, and its permission request needs you", () => {
  const other = id(801);
  let state = step(initialState(T0), "subagent.started", { toolCallId: "t1", agentName: "general-purpose" }, 1000, { agentId: HELPER });
  assert.deepEqual(view(state, T0 + 1000), { state: "working", since: T0 + 1000, activity: toolWords("task"), kind: "delegating", nextChange: null });
  state = step(state, "permission.requested", { requestId: "p1", permissionRequest: { kind: "shell" }, resolvedByHook: false }, 2000, { agentId: HELPER });
  assert.deepEqual(view(state, T0 + 2000 + PERMISSION_GRACE_MS), { state: "permission", since: T0 + 2000, activity: WORDS.permission, kind: null, nextChange: null });
  state = step(state, "permission.completed", { requestId: "p1" }, 5000, { agentId: HELPER });
  state = step(state, "subagent.started", { toolCallId: "t2", agentName: "explore" }, 5100, { agentId: other });
  state = step(state, "subagent.completed", { toolCallId: "t1" }, 6000, { agentId: HELPER });
  assert.deepEqual(view(state, T0 + 6000), { state: "working", since: T0 + 1000, activity: toolWords("task"), kind: "delegating", nextChange: null });
  state = step(state, "subagent.failed", { toolCallId: "t2", error: "Failed." }, 7000, { agentId: other });
  assert.deepEqual(view(state, T0 + 7000), { state: "working", since: T0 + 1000, activity: WORDS.working, kind: "thinking", nextChange: null });
});

test("requests for you show the oldest visible one, and permission waits out its grace period", () => {
  let state = step(initialState(T0), "user.message", {}, 0);
  assert.equal(step(state, "permission.requested", { requestId: "p0", resolvedByHook: true }, 100), state);
  state = step(state, "permission.requested", { requestId: "p1" }, 1000);
  assert.deepEqual(pick(view(state, T0 + 1000), ["state", "nextChange"]), { state: "working", nextChange: T0 + 1000 + PERMISSION_GRACE_MS });
  assert.deepEqual(view(state, T0 + 1000 + PERMISSION_GRACE_MS), { state: "permission", since: T0 + 1000, activity: WORDS.permission, kind: null, nextChange: null });
  state = step(state, "user_input.requested", { requestId: "q1", question: "Which one?" }, 2000);
  assert.equal(view(state, T0 + 2000).state, "question");
  assert.equal(view(state, T0 + 3000).state, "permission");
  assert.equal(step(state, "permission.completed", { requestId: "unknown" }, 2100), state);
  assert.equal(step(state, "permission.completed", {}, 2100), state);
  state = step(state, "permission.completed", { requestId: "p1" }, 3000);
  assert.deepEqual(view(state, T0 + 3000), { state: "question", since: T0 + 2000, activity: WORDS.question, kind: null, nextChange: null });
  state = step(state, "user_input.completed", { requestId: "q1" }, 3100);
  assert.equal(view(state, T0 + 3100).state, "working");
  state = step(state, "exit_plan_mode.requested", { requestId: "x1" }, 4000);
  assert.deepEqual(view(state, T0 + 4000), { state: "plan-ready", since: T0 + 4000, activity: WORDS["plan-ready"], kind: null, nextChange: null });
  state = step(state, "abort", { reason: "user" }, 5000);
  assert.deepEqual(view(state, T0 + 9000), { state: "idle", since: T0 + 5000, activity: WORDS.idle, kind: null, nextChange: null });
  assert.equal(step(state, "elicitation.requested", { message: "No request ID" }, 5500), state);
  state = step(state, "elicitation.requested", { requestId: "e1", message: "Pick one" }, 6000);
  assert.equal(view(state, T0 + 6000).state, "question");
  state = step(state, "session.idle", {}, 7000);
  assert.equal(view(state, T0 + 7000).state, "idle");
});

test("an error stays visible until the next turn starts", () => {
  const failed = () => step(step(initialState(T0), "user.message", {}, 0), "session.error", { errorType: "model", message: "Failed." }, 1000);
  let state = failed();
  assert.deepEqual(view(state, T0 + 1000), { state: "error", since: T0 + 1000, activity: WORDS.error, kind: null, nextChange: null });
  state = step(state, "tool.execution_start", { toolName: "bash", toolCallId: "c1" }, 1100);
  state = step(state, "assistant.intent", { intent: "Retrying" }, 1200);
  state = step(state, "tool.execution_progress", { toolCallId: "c1" }, 1300);
  state = step(state, "tool.execution_partial_result", { toolCallId: "c1" }, 1400);
  state = step(state, "subagent.started", { toolCallId: "s1" }, 1500, { agentId: HELPER });
  state = step(state, "session.idle", { mode: "plan" }, 2000);
  assert.deepEqual(view(state, T0 + 2000), { state: "error", since: T0 + 1000, activity: WORDS.error, kind: null, nextChange: null });
  assert.equal(state.mode, "plan");
  assert.deepEqual(pick(view(step(state, "assistant.turn_start", {}, 3000), T0 + 3000), ["state", "since"]), { state: "working", since: T0 + 3000 });
  assert.equal(view(step(failed(), "user.message", {}, 3000), T0 + 3000).state, "working");
  assert.equal(view(step(failed(), "abort", {}, 3000), T0 + 3000).state, "idle");
});

test("mode and title events update the name tag", () => {
  let state = initialState(T0);
  assert.equal(state.mode, null);
  state = step(state, "session.mode_changed", { previousMode: "interactive", newMode: "plan" }, 0);
  assert.equal(state.mode, "plan");
  assert.equal(step(state, "session.mode_changed", { newMode: "turbo" }, 10), state);
  state = step(state, "session.idle", { mode: "autopilot" }, 20);
  assert.equal(state.mode, "autopilot");
  state = step(state, "session.idle", { mode: "sideways" }, 30);
  assert.equal(state.mode, "autopilot");
  state = step(state, "session.title_changed", { title: "  Ship the\nbilling   fix " }, 40);
  assert.equal(state.eventTitle, "Ship the billing fix");
});

test("text is cleaned to one safe line and capped on whole characters", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  assert.equal(clean("a\u0000b\tc\n\nd", 80), "a b c d");
  assert.equal(clean("safe\u202Etxt.exe", 80), "safetxt.exe");
  assert.equal(clean("lone\uD800 surrogate", 80), "lone surrogate");
  assert.equal(clean("one\u2028two", 80), "one two");
  assert.equal(clean(`hi ${family}`, 80), `hi ${family}`);
  for (const value of [undefined, null, 5, {}]) assert.equal(clean(value, 80), "");
  assert.equal(clean("x".repeat(200), 10), `${"x".repeat(9)}…`);
  assert.equal(clean(`ab${family}cd`, 5), "ab…");
});

test("titles prefer a name the user chose and never repeat the first prompt", () => {
  const sessionId = id(1);
  const print = promptPrint(topLevel("Please fix the flaky checkout test in the payments service."));
  const title = (snapshot: Snapshot, eventTitle = "", source = print) => resolveTitle({ sessionId, snapshot, eventTitle, print: source });
  assert.equal(title({ workspace: { name: "Billing", user_named: true }, initialName: "Other", summary: "Summary" }, "Event"), "Billing");
  assert.equal(resolveTitle({ sessionId, snapshot: { workspace: { name: "Billing", user_named: true } } }), "Billing");
  assert.equal(title({ workspace: { name: "Raw first prompt", user_named: false }, initialName: "Release prep", summary: "Summary" }, "Event"), "Event");
  assert.equal(title({ workspace: { name: "Raw first prompt", user_named: false }, initialName: "Release prep", summary: "Summary" }), "Release prep");
  assert.equal(title({ summary: "Summary title" }, "Event title"), "Event title");
  assert.equal(title({ summary: "Summary title" }), "Summary title");
  assert.equal(title({ initialName: "Please fix the flaky checkout test", summary: "please FIX the flaky checkout test in payments" }), madeUpName(sessionId));
  assert.equal(title({ summary: "Summary title" }, "Flaky checkout test"), "Flaky checkout test");
  assert.equal(title({ initialName: "Please fix", summary: "the flaky checkout test in the payments service" }), madeUpName(sessionId));
  assert.equal(resolveTitle({ sessionId, snapshot: { summary: "Summary title" }, eventTitle: "Event title" }), madeUpName(sessionId));
  assert.equal(madeUpName(sessionId), madeUpName(sessionId));
  assert.ok(madeUpName(sessionId));
  assert.ok(new Set(Array.from({ length: 20 }, (_, n) => madeUpName(id(n)))).size > 10);
});

test("tools are described by what they do", () => {
  const same = (names: string[]) => {
    assert.equal(new Set(names.map(toolWords)).size, 1, names.join(" "));
    assert.equal(new Set(names.map(toolKind)).size, 1, names.join(" "));
  };
  same(["bash", "powershell", "read_bash", "write_bash", "stop_powershell", "list_bash"]);
  same(["edit", "create", "apply_patch"]);
  same(["grep", "glob"]);
  same(["web_fetch", "web_search"]);
  same(["task", "read_agent", "write_agent", "list_agents"]);
  const groups = ["bash", "edit", "view", "grep", "web_fetch", "task", "skill"].map(toolWords);
  assert.equal(new Set(groups).size, groups.length);
  assert.ok(toolWords("mystery_tool").includes("mystery_tool"));
  assert.ok(!groups.includes(toolWords("mystery_tool")));
  assert.notEqual(toolWords("mystery_tool"), toolWords("other_tool"));
  assert.ok(!toolWords("bad\nname").includes("\n"));
  assert.equal(toolWords(undefined), toolWords(""));
  assert.deepEqual(
    ["bash", "edit", "view", "grep", "web_fetch", "task", "skill", "mystery_tool", undefined].map(toolKind),
    ["terminal", "editing", "research", "research", "research", "delegating", "research", "working", "working"],
  );
  for (const name of ["bash", "edit", "view", "task", "mystery_tool"]) assert.ok(KINDS.includes(toolKind(name)), name);
});

test("the first message tells top-level sessions, My Copilot children and other children apart", () => {
  assert.equal(creatorOf(topLevel("Fix the build.")), null);
  assert.equal(creatorOf(startedInWorkspace("Fix the build.")), null);
  assert.equal(creatorOf({ content: `creator_chat_session_id: ${id(1)}\nfrom_session_id: ${id(2)}` }), null);
  assert.equal(creatorOf(undefined), null);
  assert.equal(creatorOf({}), null);
  assert.deepEqual(creatorOf(childOf(id(9))), { creatorIds: [id(9)], myCopilot: false, myCopilotIds: [] });
  assert.deepEqual(creatorOf(childOf(id(7), crossBlock({ from: id(8), name: "Helper chat" }))), { creatorIds: [id(7), id(8)], myCopilot: false, myCopilotIds: [] });
  assert.deepEqual(creatorOf({ transformedContent: `${PREAMBLE}\n\n${workspaceBlock(id(1))}\n\nHello.` }), { creatorIds: [id(1)], myCopilot: false, myCopilotIds: [] });
  assert.deepEqual(creatorOf({ content: workspaceBlock(LETTERED.toUpperCase()) })?.creatorIds, [LETTERED]);
  assert.deepEqual(creatorOf({ content: crossBlock({ from: id(9), project: id(10) }) }), { creatorIds: [id(10), id(9)], myCopilot: false, myCopilotIds: [] });
  assert.deepEqual(creatorOf(myCopilotChild(id(7))), { creatorIds: [id(7)], myCopilot: true, myCopilotIds: [id(7)] });
  assert.deepEqual(creatorOf({ content: crossBlock({ from: id(7), name: "My Copilot" }) }), { creatorIds: [id(7)], myCopilot: true, myCopilotIds: [id(7)] });
  for (const name of ["My Copilot 2", "my copilot", "Not My Copilot"]) {
    assert.equal(creatorOf(childOf(id(7), crossBlock({ from: id(7), name })))?.myCopilot, false, name);
  }
  assert.deepEqual(creatorOf({ content: workspaceBlock("not-a-session") }), { creatorIds: [], myCopilot: false, myCopilotIds: [] });
  assert.equal(creatorOf({ content: crossBlock({ from: id(1) }), transformedContent: "Plain prompt." }), null);
  assert.deepEqual(creatorOf({ content: crossBlock({ from: id(1) }), transformedContent: null })?.creatorIds, [id(1)]);
  assert.deepEqual(creatorOf({ content: `<cross_session_message>\nfrom_session_id: ${id(3)}\nUnfinished` })?.creatorIds, [id(3)]);
});

test("only the header lines of the first block of each kind name a creator", () => {
  const quoted = crossBlock({ from: id(1), text: `from_display_name: My Copilot\nfrom_session_id: ${id(2)}` });
  assert.deepEqual(creatorOf({ content: quoted }), { creatorIds: [id(1)], myCopilot: false, myCopilotIds: [] });
  const pasted = [crossBlock({ from: id(1) }), "Pasted below:", crossBlock({ from: id(2), name: "My Copilot" })].join("\n\n");
  assert.deepEqual(creatorOf({ content: pasted }), { creatorIds: [id(1)], myCopilot: false, myCopilotIds: [] });
  assert.deepEqual(creatorOf({ content: [workspaceBlock(id(1)), workspaceBlock(id(2))].join("\n\n") })?.creatorIds, [id(1)]);
  const crowded = ["<cross_session_message>", ...[1, 2, 3].map(n => `from_session_id: ${id(n)}`), "", "Hello.", "</cross_session_message>"].join("\n");
  assert.deepEqual(creatorOf({ content: crowded })?.creatorIds, [id(1), id(2)]);
});
