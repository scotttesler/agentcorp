import { constants, unlinkSync } from 'node:fs';
import { chmod, link, lstat, lutimes, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ACTIVITY_LIMIT, KINDS, MODES, NEEDS_YOU, STATES, TITLE_LIMIT, WORDS,
  clean, creatorOf, fromPrompt, initialState, isSessionId, madeUpName, promptPrint, reduce, resolveTitle, view,
} from './status.mjs';

const HEARTBEAT_MS = 15_000;
export const STALE_MS = 45_000;
const FUTURE_MS = 5_000;
const SNAPSHOT_WAIT_MS = 5_000;
const RECORD_BYTES = 4096;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const LEFTOVER_MS = 60 * 60 * 1000;
const TOUCH_MS = 60 * 60 * 1000;
const CHUNK = 1 << 20;
const HEAD_CAP = 64 << 20;
const LINE_CAP = 16 << 20;
const LINE_START = Buffer.from('{"type":"');
const MESSAGE_START = Buffer.from('{"type":"user.message",');
const SESSION_NAME = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const RECORD_NAME = new RegExp(`^(${SESSION_NAME})\\.([0-9a-f]{32})\\.json$`);
const LEFTOVER_NAME = /^\..+\.tmp$/;
const MEMORY_KEY = 'agentcorp-observer/title';
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const UNREADABLE = new Set(['ENOENT', 'ELOOP', 'EMLINK', 'EACCES', 'EPERM', 'ENXIO', 'EOPNOTSUPP']);
const RANK = { question: 0, permission: 0, 'plan-ready': 0, error: 1, working: 2, idle: 3 };
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const uid = typeof process.getuid === 'function' ? process.getuid() : null;

const mine = info => uid === null || info.uid === uid;
const privateFolder = info => info.isDirectory() && mine(info) && (info.mode & 0o077) === 0;
const folders = office => ({ presence: join(office, 'presence'), markers: join(office, 'my-copilot') });
const groupOf = state => NEEDS_YOU.includes(state) ? 'needsYou' : state;
const defaultReport = (kind, error) => process.stderr.write(`agentcorp ${kind}: ${error?.message ?? error}\n`);
const unreadable = error => {
  if (error instanceof SyntaxError || UNREADABLE.has(error?.code)) return null;
  throw error;
};
const absent = error => {
  if (error?.code === 'ENOENT') return null;
  throw error;
};

export function officeHome() {
  const copilotHome = process.env.COPILOT_HOME || join(homedir(), '.copilot');
  if (!isAbsolute(copilotHome)) throw new Error('COPILOT_HOME must be an absolute path.');
  return join(copilotHome, 'agentcorp-observer');
}

async function ensureFolder(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || !mine(info)) throw new Error(`${path} isn't a folder you own.`);
  if (info.mode & 0o077) await chmod(path, 0o700);
}

async function inspectFolder(path) {
  try {
    return privateFolder(await lstat(path)) ? {} : { problem: `Skipped ${path} because it isn't a private folder you own.` };
  } catch (error) {
    return error.code === 'ENOENT' ? { missing: true } : { problem: `Couldn't read ${path}: ${error.code ?? error.message}.` };
  }
}

async function listNames(folder) {
  const names = [];
  for await (const entry of await opendir(folder)) names.push(entry.name);
  return names;
}

async function readSmall(path, limit) {
  const handle = await open(path, READ_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !mine(info) || info.size > limit) return null;
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > limit ? null : JSON.parse(buffer.toString('utf8', 0, bytesRead));
  } finally {
    await handle.close();
  }
}

const newLine = () => ({ matched: 0, parts: null, size: 0, skip: false });
const damaged = line => line.matched < LINE_START.length || line.matched === MESSAGE_START.length - 1;

function feed(line, bytes) {
  let index = 0;
  while (!line.skip && !line.parts && index < bytes.length) {
    if (bytes[index] !== MESSAGE_START[line.matched]) line.skip = true;
    else if (++line.matched === MESSAGE_START.length) line.parts = [MESSAGE_START];
    index += 1;
  }
  if (line.parts && index < bytes.length) {
    line.size += bytes.length - index;
    if (line.size > LINE_CAP) return false;
    line.parts.push(Buffer.from(bytes.subarray(index)));
  }
  return true;
}

function messageOf(data) {
  if (!data || typeof data !== 'object') return null;
  const { content, transformedContent } = data;
  if (typeof content !== 'string' || (transformedContent !== undefined && typeof transformedContent !== 'string')) return null;
  return { content, transformedContent };
}

function parseLine(line) {
  let event;
  try {
    event = JSON.parse(Buffer.concat(line.parts).toString('utf8'));
  } catch {
    return null;
  }
  const message = event?.type === 'user.message' ? messageOf(event.data) : null;
  if (!message) return { status: 'unknown', reason: 'format' };
  return event.agentId ? { status: 'skip' } : { status: 'found', message };
}

export async function firstMessage(path, { retries = 4, retryMs = 250 } = {}) {
  let handle;
  try {
    handle = await open(path, READ_FLAGS);
  } catch (error) {
    return error.code === 'ENOENT' ? { status: 'none' } : { status: 'unknown', reason: error.code ?? 'open' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !mine(info)) return { status: 'unknown', reason: 'unsafe' };
    const buffer = Buffer.alloc(CHUNK);
    let line = newLine();
    let offset = 0;
    let waits = 0;
    for (;;) {
      if (offset >= HEAD_CAP) return { status: 'unknown', reason: 'cap' };
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, HEAD_CAP - offset), offset);
      if (bytesRead > 0) {
        waits = 0;
        const bytes = buffer.subarray(0, bytesRead);
        let start = 0;
        for (;;) {
          const end = bytes.indexOf(10, start);
          if (!feed(line, bytes.subarray(start, end === -1 ? bytesRead : end))) return { status: 'unknown', reason: 'line' };
          if (end === -1) break;
          if (line.parts) {
            const result = parseLine(line) ?? { status: 'unknown', reason: 'parse' };
            if (result.status !== 'skip') return result;
          } else if (!line.skip || damaged(line)) return { status: 'unknown', reason: 'format' };
          line = newLine();
          start = end + 1;
        }
        offset += bytesRead;
        continue;
      }
      const partial = line.parts ? parseLine(line) : null;
      if (partial && partial.status !== 'skip') return partial;
      if ((line.parts && !partial) || (!line.parts && !line.skip && line.matched > 0)) {
        if (waits >= retries) return { status: 'unknown', reason: 'partial' };
        waits += 1;
        await sleep(retryMs);
        continue;
      }
      return line.skip && damaged(line) ? { status: 'unknown', reason: 'format' } : { status: 'none' };
    }
  } finally {
    await handle.close();
  }
}

async function knownMyCopilot(office, candidates, now) {
  const ids = new Set();
  const folder = folders(office).markers;
  for (const path of [office, folder]) {
    const check = await inspectFolder(path);
    if (check.missing) return { ids };
    if (check.problem) return { ids, problem: check.problem };
  }
  for (const id of new Set(candidates)) {
    if (!isSessionId(id) || id !== id.toLowerCase()) continue;
    const info = await lstat(join(folder, id)).catch(absent);
    if (info?.isFile() && mine(info) && info.size === 0 && info.mtimeMs >= now - KEEP_MS && info.mtimeMs <= now + FUTURE_MS) ids.add(id);
  }
  return { ids };
}

async function sweep(folder, now, expired) {
  try {
    if (!privateFolder(await lstat(folder))) return;
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of await listNames(folder)) {
    const path = join(folder, name);
    const old = info => info?.isFile() && mine(info) && expired(name, now - info.mtimeMs);
    if (!old(await lstat(path).catch(() => null))) continue;
    const claim = join(folder, `.${name}.${randomBytes(16).toString('hex')}.tmp`);
    if (!await rename(path, claim).then(() => true, () => false)) continue;
    if (!old(await lstat(claim).catch(() => null))) await link(claim, path).catch(() => {});
    await unlink(claim).catch(() => {});
  }
}

async function prune(office, now) {
  const check = await inspectFolder(office);
  if (check.missing || check.problem) return;
  const paths = folders(office);
  const leftover = (name, age) => LEFTOVER_NAME.test(name) && age > LEFTOVER_MS;
  await sweep(paths.presence, now, (name, age) => leftover(name, age) || (RECORD_NAME.test(name) && age > LEFTOVER_MS));
  await sweep(paths.markers, now, (name, age) => leftover(name, age) || (isSessionId(name) && age > KEEP_MS));
}

function pickSnapshot(value) {
  const workspace = value?.workspace && typeof value.workspace === 'object' ? value.workspace : null;
  return {
    workspacePath: typeof value?.workspacePath === 'string' ? value.workspacePath : null,
    initialName: value?.initialName,
    summary: value?.summary,
    currentMode: value?.currentMode,
    workspace: workspace && { name: workspace.name, user_named: workspace.user_named },
  };
}

export function createPublisher({
  sessionId, office, report = defaultReport, heartbeatMs = HEARTBEAT_MS, coalesceMs = 250,
} = {}) {
  const reported = new Set();
  const warn = (kind, error) => {
    if (reported.has(kind)) return;
    reported.add(kind);
    try { report(kind, error); } catch {}
  };
  let home;
  try {
    if (!isSessionId(sessionId)) throw new Error('SESSION_ID is missing or invalid.');
    home = office ?? officeHome();
  } catch (error) {
    warn('setup', error);
    return { onEvent() {}, async start() {}, async stop() {} };
  }
  const self = sessionId.toLowerCase();
  const owner = randomBytes(16).toString('hex');
  const paths = folders(home);
  const recordPath = join(paths.presence, `${sessionId}.${owner}.json`);
  const timers = {};
  const born = Date.now();
  let state = initialState(born);
  let role = 'pending';
  let started = false;
  let stopped = false;
  let done = null;
  let source = null;
  let memory = null;
  let snapshot = null;
  let print = [];
  let firstLive = null;
  let wake = null;
  let creatorIds = [];
  let myCopilotIds = [];
  let signature = '';
  let savedTitle = null;
  let serial = 0;
  let asked = 0;
  let answered = 0;
  let checking = false;
  let inferred = false;
  let queue = Promise.resolve();
  let titles = Promise.resolve();

  function later(key, delay, work) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => { timers[key] = null; work(); }, delay);
    timers[key].unref?.();
  }

  function every(key, work) {
    clearTimeout(timers[key]);
    timers[key] = setInterval(work, heartbeatMs);
    timers[key].unref?.();
  }

  function schedule() {
    if (!stopped && role === 'shown' && !timers.coalesce) later('coalesce', coalesceMs, () => write(false));
  }

  function write(force) {
    queue = queue.then(() => publish(force)).catch(error => warn('write', error));
    return queue;
  }

  async function replace(path, text) {
    const temp = join(dirname(path), `.${basename(path)}.${owner}.${++serial}.tmp`);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(text);
      await handle.close();
      handle = null;
      if (stopped) throw new Error('Stopped.');
      await rename(temp, path);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      if (!stopped) throw error;
    }
  }

  async function publish(force) {
    if (stopped || role !== 'shown') return;
    const now = Date.now();
    const current = view(state, now);
    if (current.nextChange !== null) later('change', Math.max(0, current.nextChange - now) + 5, () => write(false));
    const record = {
      version: 1,
      sessionId,
      owner,
      updatedAt: new Date(now).toISOString(),
      title: resolveTitle({ sessionId, snapshot, eventTitle: state.eventTitle, print }),
      mode: state.mode,
      state: current.state,
      since: new Date(Math.min(current.since, now)).toISOString(),
      activity: current.activity,
      kind: current.kind,
    };
    const next = JSON.stringify({ ...record, updatedAt: null });
    if (force || next !== signature) {
      await ensureFolder(home);
      await ensureFolder(paths.presence);
      await replace(recordPath, JSON.stringify(record));
      signature = next;
    }
  }

  function saveTitle() {
    titles = titles.then(syncTitle).catch(error => warn('title', error));
    return titles;
  }

  async function syncTitle() {
    if (!memory) return;
    if (savedTitle === null) {
      const bag = await memory.getClientMetadata();
      savedTitle = clean(bag?.[MEMORY_KEY], TITLE_LIMIT);
      if (savedTitle && !state.eventTitle) {
        state = { ...state, eventTitle: savedTitle };
        schedule();
      }
    }
    const keep = state.eventTitle && !fromPrompt(state.eventTitle, print) ? state.eventTitle : '';
    if (keep === savedTitle) return;
    await memory.updateClientMetadata(keep ? { set: { [MEMORY_KEY]: keep } } : { remove: [MEMORY_KEY] });
    savedTitle = keep;
  }

  async function refresh() {
    if (!source || stopped) return;
    const ask = ++asked;
    const modeEvents = state.modeEvents;
    try {
      const value = await source();
      if (stopped || ask < answered) return;
      answered = ask;
      snapshot = pickSnapshot(value);
      if (state.modeEvents === modeEvents && MODES.includes(snapshot.currentMode) && snapshot.currentMode !== state.mode) {
        state = { ...state, mode: snapshot.currentMode };
      }
      schedule();
    } catch (error) {
      warn('snapshot', error);
    }
  }

  async function remember() {
    await ensureFolder(home);
    await ensureFolder(paths.markers);
    const now = Date.now();
    for (const id of myCopilotIds) {
      const path = join(paths.markers, id);
      try {
        const info = await lstat(path);
        if (info.isFile() && mine(info) && now - info.mtimeMs > TOUCH_MS) await lutimes(path, new Date(now), new Date(now));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try {
          await (await open(path, 'wx', 0o600)).close();
        } catch (failure) {
          if (failure.code !== 'EEXIST') throw failure;
        }
      }
    }
  }

  async function creatorKnown() {
    const known = await knownMyCopilot(home, creatorIds, Date.now());
    if (known.problem) warn('markers', new Error(known.problem));
    return creatorIds.some(id => known.ids.has(id));
  }

  function beat() {
    refresh();
    if (myCopilotIds.length) remember().catch(error => warn('markers', error));
    saveTitle();
    write(true);
  }

  async function show() {
    if (stopped) return;
    role = 'shown';
    if (!memory) warn('title', new Error("this app can't keep titles across reloads."));
    await Promise.race([saveTitle(), sleep(SNAPSHOT_WAIT_MS, undefined, { ref: false })]);
    if (stopped) return;
    prune(home, Date.now()).catch(error => warn('prune', error));
    every('heartbeat', inferred ? recheck : beat);
    await write(true);
  }

  async function hide() {
    role = 'hidden';
    queue = queue.then(removeRecord);
    await queue;
  }

  async function recheck() {
    if (stopped || checking) return;
    checking = true;
    try {
      const known = await creatorKnown();
      if (stopped) return;
      if (role === 'hidden' && known) await show();
      else if (role === 'shown' && !known) await hide();
      else if (role === 'shown') beat();
    } catch (error) {
      warn('recheck', error);
    } finally {
      checking = false;
    }
  }

  async function classify(message) {
    print = promptPrint(message);
    const creator = creatorOf(message);
    if (!creator) return show();
    creatorIds = creator.creatorIds.filter(id => id !== self);
    if (creator.myCopilot) {
      myCopilotIds = creator.myCopilotIds.filter(id => id !== self);
      await remember().catch(error => warn('markers', error));
      return show();
    }
    inferred = true;
    if (await creatorKnown().catch(error => { warn('markers', error); return false; })) return show();
    if (stopped) return;
    role = 'hidden';
    if (creatorIds.length) every('heartbeat', recheck);
  }

  function onEvent(event) {
    if (stopped || !event || typeof event !== 'object') return;
    try {
      if (role === 'pending' && !firstLive && event.type === 'user.message' && !event.agentId) {
        const message = messageOf(event.data);
        firstLive = message ? { status: 'found', message } : { status: 'unknown', reason: 'format' };
        wake?.();
      }
      const before = state;
      state = reduce(state, event, Date.now());
      if (event.type === 'session.title_changed') {
        refresh();
        if (role === 'shown') saveTitle();
      }
      if (event.type === 'session.shutdown' && !(Date.parse(event.timestamp) < born)) stop();
      else if (state !== before) schedule();
    } catch (error) {
      warn('event', error);
    }
  }

  async function start({ workspacePath, metadata } = {}) {
    if (started || stopped) return;
    started = true;
    source = typeof metadata?.snapshot === 'function' ? () => metadata.snapshot() : null;
    memory = typeof metadata?.getClientMetadata === 'function' && typeof metadata.updateClientMetadata === 'function' ? metadata : null;
    try {
      const loading = Promise.race([refresh(), sleep(SNAPSHOT_WAIT_MS, undefined, { ref: false })]);
      let folder = typeof workspacePath === 'string' && workspacePath ? workspacePath : null;
      if (!folder) {
        await loading;
        folder = snapshot?.workspacePath;
      }
      if (!folder) throw new Error("this session has no history folder.");
      const history = join(folder, 'events.jsonl');
      let found = await firstMessage(history);
      if (found.status === 'none' && !stopped) {
        if (!firstLive) await new Promise(resolve => { wake = resolve; });
        wake = null;
        if (stopped) return;
        found = await firstMessage(history);
        if (found.status === 'none') found = firstLive;
      }
      if (stopped) return;
      if (found.status !== 'found') throw new Error(`couldn't read this session's first message (${found.reason}).`);
      await loading;
      if (!stopped) await classify(found.message);
    } catch (error) {
      if (role === 'pending') role = 'off';
      warn('start', error);
    } finally {
      firstLive = null;
    }
  }

  function stop() {
    if (done) return done;
    stopped = true;
    for (const timer of Object.values(timers)) clearTimeout(timer);
    wake?.();
    if (role !== 'shown') return (done = queue.then(() => {}));
    try {
      unlinkSync(recordPath);
    } catch (error) {
      if (error.code !== 'ENOENT') warn('stop', error);
    }
    done = Promise.all([queue.then(removeRecord), titles]).then(() => {});
    return done;
  }

  async function removeRecord() {
    try {
      await unlink(recordPath);
    } catch (error) {
      if (error.code !== 'ENOENT') warn('stop', error);
    }
  }

  return { onEvent, start, stop };
}

async function readAgent(path, sessionId, owner, now) {
  const record = await readSmall(path, RECORD_BYTES);
  if (!record || typeof record !== 'object' || record.version !== 1 || record.sessionId !== sessionId || record.owner !== owner) return null;
  if (!STATES.includes(record.state) || (record.mode !== null && !MODES.includes(record.mode))) return null;
  if (typeof record.updatedAt !== 'string' || typeof record.since !== 'string') return null;
  const updated = Date.parse(record.updatedAt);
  const since = Date.parse(record.since);
  if (!Number.isFinite(updated) || !Number.isFinite(since)) return null;
  if (updated < now - STALE_MS || updated > now + FUTURE_MS || since > updated) return null;
  return {
    sessionId,
    title: clean(record.title, TITLE_LIMIT) || madeUpName(sessionId),
    mode: record.mode,
    state: record.state,
    since: new Date(since).toISOString(),
    activity: clean(record.activity, ACTIVITY_LIMIT) || WORDS[record.state],
    kind: record.state !== 'working' ? null : KINDS.includes(record.kind) ? record.kind : 'working',
    updatedAt: new Date(updated).toISOString(),
    url: `ghapp://sessions/${sessionId}`,
  };
}

function compareAgents(a, b) {
  return RANK[a.state] - RANK[b.state]
    || (RANK[a.state] === 0 ? Date.parse(a.since) - Date.parse(b.since) : 0)
    || collator.compare(a.title, b.title)
    || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
}

export async function readRoster(office, { now = Date.now() } = {}) {
  const directory = folders(office).presence;
  const roster = { agents: [], counts: { needsYou: 0, error: 0, working: 0, idle: 0 } };
  for (const path of [office, directory]) {
    const check = await inspectFolder(path);
    if (check.missing) return roster;
    if (check.problem) return { ...roster, problem: check.problem };
  }
  const names = (await listNames(directory)).filter(name => RECORD_NAME.test(name)).sort();
  const freshest = new Map();
  for (const name of names) {
    const [, sessionId, owner] = RECORD_NAME.exec(name);
    const agent = await readAgent(join(directory, name), sessionId, owner, now).catch(unreadable);
    if (!agent) continue;
    const key = agent.sessionId.toLowerCase();
    const kept = freshest.get(key);
    if (!kept || Date.parse(agent.updatedAt) > Date.parse(kept.updatedAt)) freshest.set(key, agent);
  }
  const known = await knownMyCopilot(office, [...freshest.keys()], now);
  roster.agents = [...freshest].filter(([key]) => !known.ids.has(key)).map(([, agent]) => agent).sort(compareAgents);
  for (const agent of roster.agents) roster.counts[groupOf(agent.state)] += 1;
  if (known.problem) roster.problem = known.problem;
  return roster;
}
