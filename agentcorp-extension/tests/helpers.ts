import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsPromises, { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublisher, type Metadata, type Publisher } from "../../.github/extensions/agentcorp-extension/presence.mjs";
import { WORDS, reduce, type Message, type StatusState } from "../../.github/extensions/agentcorp-extension/status.mjs";

export const T0 = Date.parse("2026-01-01T09:00:00.000Z");
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const LETTERED = "abcdef01-2345-4678-9abc-def012345678";
export const HELPER = id(800);
export const MEMORY_KEY = "agentcorp-observer/title";
const OWNED_RECORD = /^\.[0-9a-f]{32}\.json$/;

export type StoredRecord = {
  version: number;
  sessionId: string;
  owner: string;
  updatedAt: string;
  title: string;
  mode: string | null;
  state: string;
  since: string;
  activity: string;
  kind?: string | null;
};
export type Bag = Record<string, unknown>;
export type Stand = Required<Metadata>;
export type Envelope = { type: string; data: unknown; agentId?: string; id: string; timestamp: string; parentId: string | null };
export type Reports = Array<[string, string]>;
export type Sent = { status: number; headers: IncomingHttpHeaders; body: string };

export function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown> | null | undefined;
  return Object.fromEntries(keys.map(key => [key, source?.[key]]));
}

export const lines = (...events: unknown[]): string => events.map(event => `${JSON.stringify(event)}\n`).join("");
export const permissions = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777;
export const readJson = async (path: string): Promise<StoredRecord> => JSON.parse(await readFile(path, "utf8"));
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export function rpcMetadata(values: Record<string, unknown>, bag: Bag = {}): Stand {
  return {
    snapshot: async () => structuredClone(values),
    getClientMetadata: async () => ({ ...bag }),
    updateClientMetadata: async ({ clear = false, remove = [], set = {} }) => {
      if (clear) for (const key of Object.keys(bag)) delete bag[key];
      for (const key of remove) delete bag[key];
      Object.assign(bag, set);
      return { ...bag };
    },
  };
}

export async function recordFiles(office: string, sessionId: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(office, "presence"));
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  return names
    .filter(name => name.startsWith(sessionId) && OWNED_RECORD.test(name.slice(sessionId.length)))
    .map(name => join(office, "presence", name));
}

export async function recordOf(office: string, sessionId: string): Promise<string> {
  const paths = await recordFiles(office, sessionId);
  assert.equal(paths.length, 1, `${sessionId} should have exactly one record`);
  return paths[0];
}

export const readRecord = async (office: string, sessionId: string): Promise<StoredRecord> => readJson(await recordOf(office, sessionId));
export const hasRecord = async (office: string, sessionId: string): Promise<boolean> => (await recordFiles(office, sessionId)).length > 0;

function envelope(type: string, data: unknown, at: number, agentId?: string): Envelope {
  return {
    type, data, ...(agentId ? { agentId } : {}),
    id: randomUUID(), timestamp: new Date(at).toISOString(), parentId: type === "session.start" ? null : randomUUID(),
  };
}

export const ev = (type: string, data: unknown = {}, ms = 0, { agentId }: { agentId?: string } = {}): Envelope =>
  envelope(type, data, T0 + ms, agentId);
export const live = (type: string, data: unknown = {}, { agentId }: { agentId?: string } = {}): Envelope =>
  envelope(type, data, Date.now(), agentId);
export const step = (state: StatusState, type: string, data: unknown, ms: number, extra?: { agentId?: string }): StatusState =>
  reduce(state, ev(type, data, ms, extra), T0 + ms);

const cleanups = new WeakMap<TestContext, Array<() => unknown>>();

export function cleanUp(t: TestContext, task: () => unknown): void {
  let tasks = cleanups.get(t);
  if (!tasks) {
    const list: Array<() => unknown> = [];
    cleanups.set(t, list);
    t.after(async () => { for (const next of list.reverse()) await next(); });
    tasks = list;
  }
  tasks.push(task);
}

export async function temporary(t: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agentcorp-test-")));
  cleanUp(t, () => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function eventually<T>(check: () => Promise<T> | T, { timeout = 3000, interval = 10 } = {}): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await sleep(interval);
  }
}

type Patchable = "rename" | "open" | "lstat";

export function patchFs<K extends Patchable>(
  t: TestContext,
  name: K,
  make: (real: (typeof fsPromises)[K]) => (typeof fsPromises)[K],
): void {
  const target = fsPromises as unknown as Record<K, (typeof fsPromises)[K]>;
  const real = target[name];
  target[name] = make(real);
  syncBuiltinESMExports();
  t.after(() => {
    target[name] = real;
    syncBuiltinESMExports();
  });
}

export const tagged = (tag: string, text = "Example context."): string => `<${tag}>\n${text}\n</${tag}>`;
export const PREAMBLE = tagged("example_preamble");

export function workspaceBlock(creator?: string): string {
  return [
    "<copilot_tauri_workspace>",
    `example_session_id: ${id(901)}`,
    "example_field: example",
    ...(creator ? [`creator_chat_session_id: ${creator}`] : []),
    "</copilot_tauri_workspace>",
  ].join("\n");
}

export function crossBlock({ from, project, name = "Example sender", text = "Please take this task." }: {
  from: string;
  project?: string;
  name?: string;
  text?: string;
}): string {
  const sender = [
    ...(project ? [`from_project_session_id: ${project}`] : []),
    `from_session_id: ${from}`,
    `from_display_name: ${name}`,
    "example_field: example",
  ];
  return ["<cross_session_message>", ...sender, "", text, "</cross_session_message>"].join("\n");
}

export type Prompt = { content: string; transformedContent?: string };

export const topLevel = (text: string): Prompt => ({
  content: text,
  transformedContent: `${PREAMBLE}\n\n${text}\n\n${tagged("example_notes")}`,
});

export const startedInWorkspace = (text: string): Prompt => ({
  content: text,
  transformedContent: `${PREAMBLE}\n\n${text}${workspaceBlock()}\n\n${tagged("example_notes")}`,
});

export function childOf(creator: string, cross = crossBlock({ from: creator, project: creator })): Prompt {
  const text = "Please take this task.";
  const blocks = [
    PREAMBLE, cross, workspaceBlock(creator), tagged("example_context"), text, tagged("example_notes"),
  ];
  return { content: text, transformedContent: blocks.join("\n\n") };
}

export const myCopilotChild = (creator: string): Prompt =>
  childOf(creator, crossBlock({ from: creator, name: "My Copilot" }));

export const userMessage = ({ content, transformedContent }: Message): Record<string, unknown> => ({
  content, transformedContent, messageId: randomUUID(), supportedNativeDocumentMimeTypes: [], agentMode: "autopilot",
  delivery: "idle", interactionId: randomUUID(), turnId: "0", parentAgentTaskId: null,
});

export async function sessionFolder(root: string, sessionId: string, message?: Message | null): Promise<string> {
  const folder = join(root, "session-state", sessionId);
  await mkdir(folder, { recursive: true });
  const start = ev("session.start", {
    sessionId, version: 1, producer: "copilot-agent", copilotVersion: "1.0.91", startTime: new Date(T0).toISOString(),
    contextTier: null, context: { cwd: root }, remoteSteerable: false, alreadyInUse: false,
  });
  await writeFile(join(folder, "events.jsonl"), lines(start, ...(message ? [ev("user.message", userMessage(message), 1000)] : [])));
  return folder;
}

export async function officeFolders(root: string, ...names: string[]): Promise<string> {
  const office = join(root, "agentcorp-observer");
  await mkdir(office, { mode: 0o700 });
  for (const name of names) await mkdir(join(office, name), { mode: 0o700 });
  return office;
}

export function publisherFor(
  t: TestContext,
  office: string,
  sessionId: string,
  options: { heartbeatMs?: number; coalesceMs?: number } = {},
): { publisher: Publisher; reports: Reports } {
  const reports: Reports = [];
  const report = (kind: string, error: unknown) => {
    reports.push([kind, (error as Error | undefined)?.message ?? String(error)]);
  };
  const publisher = createPublisher({ sessionId, office, coalesceMs: 5, report, ...options });
  cleanUp(t, () => publisher.stop());
  return { publisher, reports };
}

export function validRecord(sessionId: string, now: number, fields: Record<string, unknown> = {}): StoredRecord {
  return {
    version: 1,
    sessionId,
    owner: "a".repeat(32),
    updatedAt: new Date(now - 1000).toISOString(),
    title: "Example",
    mode: "interactive",
    state: "idle",
    since: new Date(now - 60_000).toISOString(),
    activity: WORDS.idle,
    ...fields,
  } as StoredRecord;
}

export async function putRecord(office: string, record: StoredRecord | string, name?: string): Promise<string> {
  const file = name ?? (typeof record === "string" ? assert.fail("Name a raw record.") : `${record.sessionId}.${record.owner}.json`);
  const path = join(office, "presence", file);
  await writeFile(path, typeof record === "string" ? record : JSON.stringify(record), { mode: 0o600 });
  return path;
}

export function send(url: string | URL, { method = "GET", headers = {} }: { method?: string; headers?: Record<string, string> } = {}): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers, agent: false }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

export function observationsUrl(viewerUrl: string): URL {
  const target = new URL(viewerUrl);
  target.pathname = "/api/observations";
  return target;
}
