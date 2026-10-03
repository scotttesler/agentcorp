import type { Kind, Message, Mode, State } from "./status.mjs";

export type Counts = { needsYou: number; error: number; working: number; idle: number };
export type Agent = {
  sessionId: string;
  title: string;
  mode: Mode | null;
  state: State;
  since: string;
  activity: string;
  kind: Kind | null;
  updatedAt: string;
  url: string;
};
export type Roster = { agents: Agent[]; counts: Counts; problem?: string };
export type FirstMessage =
  | { status: "found"; message: Message }
  | { status: "none" }
  | { status: "unknown"; reason: string };
export type Metadata = {
  snapshot?: () => Promise<unknown>;
  getClientMetadata?: () => Promise<Record<string, unknown>>;
  updateClientMetadata?: (change: { set?: Record<string, unknown>; remove?: string[]; clear?: boolean }) => Promise<unknown>;
};
export type Publisher = {
  onEvent(event: unknown): void;
  start(options?: { workspacePath?: string | null; metadata?: Metadata | null }): Promise<void>;
  stop(): Promise<void>;
};

export const STALE_MS: number;
export function officeHome(): string;
export function firstMessage(path: string, options?: { retries?: number; retryMs?: number }): Promise<FirstMessage>;
export function createPublisher(options?: {
  sessionId?: unknown;
  office?: string;
  report?: (kind: string, error: unknown) => void;
  heartbeatMs?: number;
  coalesceMs?: number;
}): Publisher;
export function readRoster(office: string, options?: { now?: number; maxFiles?: number }): Promise<Roster>;
