export const MODES = Object.freeze(['interactive', 'plan', 'autopilot']);
export const STATES = Object.freeze(['question', 'permission', 'plan-ready', 'error', 'working', 'idle']);
export const NEEDS_YOU = Object.freeze(['question', 'permission', 'plan-ready']);
export const KINDS = Object.freeze(['thinking', 'terminal', 'research', 'editing', 'delegating', 'working']);
export const TITLE_LIMIT = 80;
export const ACTIVITY_LIMIT = 100;
export const PERMISSION_GRACE_MS = 1500;
export const WORDS = Object.freeze({
  question: 'Has a question for you',
  permission: 'Needs your permission',
  'plan-ready': 'Plan ready for review',
  error: 'Hit an error',
  working: 'Thinking',
  idle: 'Taking a break',
});

const HELPERS = 'Working with helper agents';
const LIMITS = Object.freeze({ tools: 64, helpers: 64, pending: 32 });
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUESTS = new Map([
  ['user_input.requested', 'question'],
  ['elicitation.requested', 'question'],
  ['permission.requested', 'permission'],
  ['auto_mode_switch.requested', 'permission'],
  ['session_limits_exhausted.requested', 'permission'],
  ['exit_plan_mode.requested', 'plan-ready'],
]);
const COMPLETIONS = new Set([
  'user_input.completed', 'elicitation.completed', 'permission.completed',
  'auto_mode_switch.completed', 'session_limits_exhausted.completed', 'exit_plan_mode.completed',
]);
const HELPER_EVENTS = new Set(['permission.requested', 'permission.completed', 'subagent.started', 'subagent.completed', 'subagent.failed']);
const TRACKED_EVENTS = new Set([
  'user.message', 'assistant.turn_start', 'assistant.intent', 'assistant.idle',
  'tool.execution_start', 'tool.execution_partial_result', 'tool.execution_progress', 'tool.execution_complete',
  'subagent.started', 'subagent.completed', 'subagent.failed',
  'session.idle', 'abort', 'session.error', 'session.mode_changed', 'session.title_changed',
]);
const QUIET_TOOLS = new Set(['report_intent', 'ask_user', 'exit_plan_mode', 'task_complete']);
const TOOL_WORDS = [
  [/^(?:(?:read|write|stop|list)_)?(?:bash|powershell)$/, 'Running a command', 'terminal'],
  [/^(?:edit|create|apply_patch)$/, 'Editing files', 'editing'],
  [/^view$/, 'Reading files', 'research'],
  [/^(?:grep|glob)$/, 'Searching files', 'research'],
  [/^(?:web_fetch|web_search)$/, 'Browsing the web', 'research'],
  [/^(?:task|read_agent|write_agent|list_agents)$/, HELPERS, 'delegating'],
  [/^skill$/, 'Loading a skill', 'research'],
];
const ADJECTIVES = [
  'Amber', 'Bold', 'Breezy', 'Brisk', 'Calm', 'Cheery', 'Clever', 'Cosmic', 'Daring', 'Dapper', 'Eager', 'Frosty', 'Fuzzy', 'Gentle', 'Golden', 'Happy',
  'Jolly', 'Keen', 'Lucky', 'Mellow', 'Nimble', 'Plucky', 'Quiet', 'Rapid', 'Rosy', 'Snappy', 'Sunny', 'Swift', 'Tidy', 'Vivid', 'Witty', 'Zesty',
];
const NOUNS = [
  'badger', 'beaver', 'comet', 'dolphin', 'falcon', 'ferret', 'fox', 'gecko', 'heron', 'koala', 'lemur', 'lynx', 'marmot', 'narwhal', 'ocelot', 'otter',
  'panda', 'pelican', 'penguin', 'puffin', 'quokka', 'raven', 'robin', 'salmon', 'seal', 'sparrow', 'tapir', 'tiger', 'walrus', 'wombat', 'yak', 'zebra',
];
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const PROMPT_PRINT = 16384;
const TITLE_KEY = 24;

export const isSessionId = value => typeof value === 'string' && SESSION_ID.test(value);

export function clean(value, limit) {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/(?![\u200c\u200d])[\p{Cf}\p{Cs}]/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if ([...text].length <= limit) return text;
  let kept = '';
  let size = 0;
  for (const { segment } of graphemes.segment(text)) {
    const points = [...segment].length;
    if (size + points > limit - 1) break;
    kept += segment;
    size += points;
  }
  return `${kept.trimEnd()}…`;
}

function hash(text) {
  let value = 0x811c9dc5;
  for (const character of String(text)) {
    value ^= character.codePointAt(0);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

export function madeUpName(sessionId) {
  const value = hash(sessionId);
  return `${ADJECTIVES[value & 31]} ${NOUNS[(value >>> 5) & 31]}`;
}

const toolEntry = name => TOOL_WORDS.find(([pattern]) => pattern.test(typeof name === 'string' ? name : ''));

export function toolWords(name) {
  const entry = toolEntry(name);
  if (entry) return entry[1];
  const label = clean(typeof name === 'string' ? name : '', 40);
  return label ? `Using ${label}` : 'Using a tool';
}

export const toolKind = name => toolEntry(name)?.[2] ?? 'working';

export function initialState(now) {
  return { mode: null, modeEvents: 0, phase: 'idle', since: now, intent: '', tools: new Map(), helpers: new Set(), pending: new Map(), eventTitle: '' };
}

function copy(state) {
  return { ...state, tools: new Map(state.tools), helpers: new Set(state.helpers), pending: new Map(state.pending) };
}

function enter(state, phase, time) {
  if (state.phase === phase) return;
  state.phase = phase;
  state.since = time;
}

function settle(state, phase, time) {
  state.pending.clear();
  state.tools.clear();
  state.helpers.clear();
  state.intent = '';
  enter(state, phase, time);
}

function bound(collection, limit) {
  while (collection.size > limit) collection.delete(collection.keys().next().value);
}

const idOf = value => (typeof value === 'string' && value) || null;

export function reduce(state, event, now) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return state;
  if (event.agentId && !HELPER_EVENTS.has(event.type)) return state;
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
  const stamp = Date.parse(event.timestamp);
  const time = Number.isFinite(stamp) ? Math.min(stamp, now) : now;
  const requestId = idOf(data.requestId);
  if (REQUESTS.has(event.type)) {
    if (!requestId || (event.type === 'permission.requested' && data.resolvedByHook === true)) return state;
    const kind = REQUESTS.get(event.type);
    const next = copy(state);
    next.pending.delete(requestId);
    next.pending.set(requestId, { kind, at: time, visibleAt: kind === 'permission' ? time + PERMISSION_GRACE_MS : time });
    bound(next.pending, LIMITS.pending);
    return next;
  }
  if (COMPLETIONS.has(event.type)) {
    if (!requestId || !state.pending.has(requestId)) return state;
    const next = copy(state);
    next.pending.delete(requestId);
    return next;
  }
  if (!TRACKED_EVENTS.has(event.type)) return state;
  const next = copy(state);
  const busy = () => { if (next.phase !== 'error') enter(next, 'working', time); };
  const callId = idOf(data.toolCallId) ?? idOf(event.id);
  switch (event.type) {
    case 'user.message':
      next.intent = '';
      enter(next, 'working', time);
      break;
    case 'assistant.turn_start':
      enter(next, 'working', time);
      break;
    case 'assistant.intent':
      next.intent = clean(data.intent, ACTIVITY_LIMIT);
      busy();
      break;
    case 'assistant.idle':
      next.intent = '';
      next.tools.clear();
      break;
    case 'tool.execution_start':
      if (!QUIET_TOOLS.has(data.toolName) && callId) {
        next.tools.delete(callId);
        next.tools.set(callId, { words: toolWords(data.toolName), kind: toolKind(data.toolName) });
        bound(next.tools, LIMITS.tools);
      }
      busy();
      break;
    case 'tool.execution_partial_result':
    case 'tool.execution_progress':
      busy();
      break;
    case 'tool.execution_complete':
      next.tools.delete(idOf(data.toolCallId));
      break;
    case 'subagent.started':
      if (callId) {
        next.helpers.add(callId);
        bound(next.helpers, LIMITS.helpers);
      }
      busy();
      break;
    case 'subagent.completed':
    case 'subagent.failed':
      next.helpers.delete(idOf(data.toolCallId));
      break;
    case 'session.idle':
      settle(next, next.phase === 'error' ? 'error' : 'idle', time);
      if (MODES.includes(data.mode)) {
        next.mode = data.mode;
        next.modeEvents += 1;
      }
      break;
    case 'abort':
      settle(next, 'idle', time);
      break;
    case 'session.error':
      settle(next, 'error', time);
      break;
    case 'session.mode_changed':
      if (!MODES.includes(data.newMode)) return state;
      next.mode = data.newMode;
      next.modeEvents += 1;
      break;
    case 'session.title_changed':
      next.eventTitle = clean(data.title, TITLE_LIMIT);
      break;
  }
  return next;
}

export function view(state, now) {
  let shown = null;
  let nextChange = null;
  for (const request of state.pending.values()) {
    if (request.visibleAt > now) nextChange = Math.min(nextChange ?? Infinity, request.visibleAt);
    else if (!shown || request.at < shown.at) shown = request;
  }
  if (shown) return { state: shown.kind, since: shown.at, activity: WORDS[shown.kind], kind: null, nextChange };
  if (state.phase === 'working') {
    const tool = [...state.tools.values()].at(-1);
    const helping = state.helpers.size > 0;
    return {
      state: 'working',
      since: state.since,
      activity: state.intent || tool?.words || (helping ? HELPERS : WORDS.working),
      kind: tool?.kind ?? (helping ? 'delegating' : 'thinking'),
      nextChange,
    };
  }
  return { state: state.phase, since: state.since, activity: WORDS[state.phase], kind: null, nextChange };
}

const squash = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function promptPrint(message) {
  return [message?.content, message?.transformedContent]
    .filter(text => typeof text === 'string')
    .map(text => squash(text.slice(0, PROMPT_PRINT * 4)).slice(0, PROMPT_PRINT));
}

export function fromPrompt(title, print) {
  const points = [...squash(title)].slice(0, TITLE_KEY);
  const key = points.join('');
  const long = points.length === TITLE_KEY;
  return print.some(source => source.startsWith(key) || (long && source.includes(key)));
}

export function resolveTitle({ sessionId, snapshot, eventTitle, print }) {
  const workspace = snapshot?.workspace;
  if (workspace?.user_named === true) {
    const name = clean(workspace.name, TITLE_LIMIT);
    if (name) return name;
  }
  for (const candidate of [eventTitle, snapshot?.initialName, snapshot?.summary]) {
    const title = clean(candidate, TITLE_LIMIT);
    if (title && Array.isArray(print) && !fromPrompt(title, print)) return title;
  }
  return madeUpName(sessionId);
}

const WORKSPACE_BLOCK = /<copilot_tauri_workspace>([\s\S]*?)(?:<\/copilot_tauri_workspace>|$)/;
const CROSS_SESSION_BLOCK = /<cross_session_message>([\s\S]*?)(?:<\/cross_session_message>|$)/;
const CREATOR_LINES = /^[ \t]*creator_[a-z_]*session_id:[ \t]*(\S+)/gm;
const SENDER_LINES = /^[ \t]*from_(?:project_)?session_id:[ \t]*(\S+)/gm;
const MY_COPILOT_LINE = /^[ \t]*from_display_name:[ \t]*My Copilot[ \t\r]*$/m;
const BLOCK_IDS = 2;

function headerOf(text, block) {
  const body = text.match(block)?.[1];
  if (body === undefined) return '';
  const lines = body.replace(/^[ \t]*\r?\n/, '');
  const end = lines.search(/\r?\n[ \t]*\r?\n/);
  return end === -1 ? lines : lines.slice(0, end);
}

function idsIn(header, pattern) {
  const values = [...header.matchAll(pattern)].map(([, value]) => value);
  return { tagged: values.length > 0, ids: values.filter(isSessionId).slice(0, BLOCK_IDS).map(value => value.toLowerCase()) };
}

export function creatorOf(message) {
  const text = typeof message?.transformedContent === 'string' ? message.transformedContent
    : typeof message?.content === 'string' ? message.content : '';
  const workspace = idsIn(headerOf(text, WORKSPACE_BLOCK), CREATOR_LINES);
  const crossHeader = headerOf(text, CROSS_SESSION_BLOCK);
  const cross = idsIn(crossHeader, SENDER_LINES);
  if (!workspace.tagged && !cross.tagged) return null;
  const myCopilot = MY_COPILOT_LINE.test(crossHeader);
  return {
    creatorIds: [...new Set([...workspace.ids, ...cross.ids])],
    myCopilot,
    myCopilotIds: myCopilot ? [...new Set(cross.ids)] : [],
  };
}
