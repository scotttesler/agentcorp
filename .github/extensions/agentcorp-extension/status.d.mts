export type Mode = "interactive" | "plan" | "autopilot";
export type Waiting = "question" | "permission" | "plan-ready";
export type State = Waiting | "error" | "working" | "idle";
export type Kind = "thinking" | "terminal" | "research" | "editing" | "delegating" | "working";
export type Message = { content?: unknown; transformedContent?: unknown };
export type Snapshot = {
  initialName?: unknown;
  summary?: unknown;
  workspace?: { name?: unknown; user_named?: unknown } | null;
};
export type StatusState = {
  mode: Mode | null;
  modeEvents: number;
  phase: "idle" | "working" | "error";
  since: number;
  intent: string;
  tools: Map<string, { words: string; kind: Kind }>;
  helpers: Set<string>;
  pending: Map<string, { kind: Waiting; at: number; visibleAt: number }>;
  eventTitle: string;
};
export type StatusView = { state: State; since: number; activity: string; kind: Kind | null; nextChange: number | null };
export type Creator = { creatorIds: string[]; myCopilot: boolean; myCopilotIds: string[] };

export const MODES: readonly Mode[];
export const STATES: readonly State[];
export const NEEDS_YOU: readonly Waiting[];
export const KINDS: readonly Kind[];
export const TITLE_LIMIT: number;
export const ACTIVITY_LIMIT: number;
export const PERMISSION_GRACE_MS: number;
export const WORDS: Readonly<Record<State, string>>;
export function isSessionId(value: unknown): value is string;
export function clean(value: unknown, limit: number): string;
export function madeUpName(sessionId: string): string;
export function toolWords(name: unknown): string;
export function toolKind(name: unknown): Kind;
export function initialState(now: number): StatusState;
export function reduce(state: StatusState, event: unknown, now: number): StatusState;
export function view(state: StatusState, now: number): StatusView;
export function promptPrint(message: Message | null | undefined): string[];
export function fromPrompt(title: string, print: readonly string[]): boolean;
export function resolveTitle(input: {
  sessionId: string;
  snapshot?: Snapshot | null;
  eventTitle?: string;
  print?: readonly string[] | null;
}): string;
export function creatorOf(message: Message | null | undefined): Creator | null;
