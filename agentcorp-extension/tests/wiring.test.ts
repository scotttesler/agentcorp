import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRoster } from "../../.github/extensions/agentcorp-extension/presence.mjs";
import {
  MEMORY_KEY, eventually, hasRecord, id, live, observationsUrl, pick, readRecord, rpcMetadata, send, sessionFolder, temporary, topLevel,
  type Bag, type Stand,
} from "./helpers";

type Opened = { title: string; url: string };
type Canvas = {
  id: string;
  open(request: { sessionId: string; instanceId: string; input?: unknown }): Promise<Opened>;
  onClose(request: { instanceId: string }): Promise<void>;
};
type Config = { onEvent?: (event: unknown) => void; canvases: Canvas[] };
type Harness = { metadata: Stand; workspacePath: string; config?: Config };

declare global {
  var __agentcorpHarness: Harness | undefined;
}

const SDK = "@github/copilot-sdk/extension";
const extension = new URL("../../.github/extensions/agentcorp-extension/extension.mjs", import.meta.url);
const sdkMock = (joinSession: string) => `data:text/javascript,${encodeURIComponent(`export const createCanvas = options => options;\n${joinSession}`)}`;
const fromHarness = sdkMock([
  "export async function joinSession(config) {",
  "  const harness = globalThis.__agentcorpHarness;",
  "  harness.config = config;",
  "  return { workspacePath: harness.workspacePath, rpc: { metadata: harness.metadata } };",
  "}",
].join("\n"));

async function loadExtension(t: TestContext, { root, sessionId, harness, copy }: {
  root: string;
  sessionId: string;
  harness: Harness;
  copy: string;
}): Promise<Config> {
  const saved = { SESSION_ID: process.env.SESSION_ID, COPILOT_HOME: process.env.COPILOT_HOME };
  process.env.SESSION_ID = sessionId;
  process.env.COPILOT_HOME = root;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const names = ["exit", "SIGTERM", "SIGINT"];
  const before = new Map(names.map(name => [name, process.listeners(name as NodeJS.Signals)]));
  t.after(() => {
    for (const [name, listeners] of before) {
      for (const listener of process.listeners(name as NodeJS.Signals)) {
        if (!listeners.includes(listener)) process.removeListener(name, listener);
      }
    }
  });
  globalThis.__agentcorpHarness = harness;
  t.after(() => { delete globalThis.__agentcorpHarness; });
  const hooks = registerHooks({
    resolve: (specifier, context, next) => specifier === SDK ? { url: fromHarness, shortCircuit: true } : next(specifier, context),
  });
  t.after(() => hooks.deregister());
  await import(`${extension.href}?${copy}`);
  assert.ok(harness.config, "the extension should join its session");
  return harness.config;
}

test("the extension publishes its own session and serves each canvas panel separately", async t => {
  const root = await temporary(t);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Plan the week."));
  const bag: Bag = {};
  const harness: Harness = { metadata: rpcMetadata({ summary: "Weekly planning", currentMode: "autopilot" }, bag), workspacePath: folder };
  const config = await loadExtension(t, { root, sessionId, harness, copy: "active" });
  const onEvent = config.onEvent;
  assert.ok(onEvent, "the extension should follow session events");
  t.after(() => onEvent(live("session.shutdown")));
  assert.deepEqual(config.canvases.map(canvas => canvas.id), ["agentcorp-observer"]);
  const [canvas] = config.canvases;
  const office = join(root, "agentcorp-observer");
  const agents = async () => (await readRoster(office)).agents;

  await eventually(async () => assert.deepEqual(pick((await agents())[0], ["sessionId", "title", "mode", "state", "url"]), {
    sessionId, title: "Weekly planning", mode: "autopilot", state: "idle", url: `ghapp://sessions/${sessionId}`,
  }));
  onEvent(live("user.message", { content: "Go." }));
  await eventually(async () => assert.equal((await agents())[0]?.state, "working"));
  onEvent(live("session.title_changed", { title: "Named by the agent" }));
  await eventually(async () => assert.equal((await agents())[0]?.title, "Named by the agent"));
  await eventually(() => assert.deepEqual(bag, { [MEMORY_KEY]: "Named by the agent" }));

  const one = await canvas.open({ sessionId, instanceId: "one" });
  const again = await canvas.open({ sessionId, instanceId: "one" });
  const two = await canvas.open({ sessionId, instanceId: "two", input: {} });
  t.after(async () => {
    await canvas.onClose({ instanceId: "one" });
    await canvas.onClose({ instanceId: "two" });
  });
  assert.equal(one.url, again.url);
  assert.notEqual(one.url, two.url);
  for (const { url } of [one, two]) {
    const served = await send(observationsUrl(url));
    assert.equal(served.status, 200);
    const observed = JSON.parse(served.body);
    assert.equal(observed.root, sessionId);
    assert.deepEqual(pick(observed.sessions[0], ["id", "title", "state", "url"]), {
      id: sessionId, title: "Named by the agent", state: "working", url: `ghapp://sessions/${sessionId}`,
    });
  }
  const crossed = observationsUrl(one.url);
  crossed.searchParams.set("key", new URL(two.url).searchParams.get("key") ?? "");
  assert.equal((await send(crossed)).status, 403);

  const logged = t.mock.method(console, "error", () => {});
  process.env.COPILOT_HOME = "relative/home";
  assert.equal((await send(observationsUrl(one.url))).status, 500);
  process.env.COPILOT_HOME = root;
  logged.mock.restore();
  assert.equal(logged.mock.callCount(), 1);

  await canvas.onClose({ instanceId: "two" });
  await assert.rejects(send(observationsUrl(two.url)), { code: "ECONNREFUSED" });
  assert.equal((await send(observationsUrl(one.url))).status, 200);

  onEvent(live("session.shutdown"));
  assert.deepEqual(await agents(), []);
});

test("a second copy of the extension stays out of the office when the user-scope copy owns it", async t => {
  const root = await temporary(t);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Plan the week."));
  const installed = join(root, "extensions", "agentcorp-extension");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "extension.mjs"), "");
  t.mock.method(console, "error", () => {});
  const harness: Harness = { metadata: rpcMetadata({ summary: "Weekly planning", currentMode: "plan" }), workspacePath: folder };
  const config = await loadExtension(t, { root, sessionId, harness, copy: "inactive" });
  assert.deepEqual(config.canvases, []);
  assert.equal(config.onEvent, undefined);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await hasRecord(join(root, "agentcorp-observer"), sessionId), false);
});

test("the extension process removes its record when the app stops it", async t => {
  const root = await temporary(t);
  const sessionId = id(1);
  const folder = await sessionFolder(root, sessionId, topLevel("Plan the week."));
  const url = sdkMock([
    "const values = { summary: 'Weekly planning', currentMode: 'plan' };",
    "const metadata = { snapshot: async () => values, getClientMetadata: async () => ({}), updateClientMetadata: async () => ({}) };",
    "export async function joinSession() {",
    "  setInterval(() => {}, 1000);",
    `  return { workspacePath: ${JSON.stringify(folder)}, rpc: { metadata } };`,
    "}",
  ].join("\n"));
  const register = join(root, "register.mjs");
  await writeFile(register, [
    'import { registerHooks } from "node:module";',
    `registerHooks({ resolve: (specifier, context, next) => specifier === ${JSON.stringify(SDK)} ? { url: ${JSON.stringify(url)}, shortCircuit: true } : next(specifier, context) });`,
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, SESSION_ID: sessionId, COPILOT_HOME: root };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", pathToFileURL(register).href, fileURLToPath(extension)], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
  const office = join(root, "agentcorp-observer");

  await eventually(async () => assert.deepEqual(pick(await readRecord(office, sessionId), ["title", "mode"]), {
    title: "Weekly planning", mode: "plan",
  }), { timeout: 5000 });
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.deepEqual(await readdir(join(office, "presence")), []);
  assert.equal(stdout, "");
  assert.deepEqual(stderr.split("\n").filter(line => /agentcorp/i.test(line)), []);
});
