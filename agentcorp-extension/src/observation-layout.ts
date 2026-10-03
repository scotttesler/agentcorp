import type { Observed } from "../../.github/extensions/agentcorp-extension/observations.mjs";
import type { Counts } from "../../.github/extensions/agentcorp-extension/presence.mjs";
import { MAX_LIVE_DESKS } from "../game/live-layout";
import type { Agent } from "../game/simulation";
import type { LiveNoticeActivity } from "../game/sprite-art";

export type Member = Observed;
export type Observation = { root: string; sessions: Member[]; overflow: number; counts: Counts };

const STATES: Record<Member["state"], true> = {
  question: true, permission: true, "plan-ready": true, error: true, working: true, idle: true,
};
const KINDS: Record<NonNullable<Member["kind"]>, true> = {
  thinking: true, terminal: true, research: true, editing: true, delegating: true, working: true,
};
const MODES: Record<NonNullable<Member["mode"]>, true> = { interactive: true, plan: true, autopilot: true };
const SESSION_LINK = /^ghapp:\/\/sessions\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null;
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const isOneOf = (value: unknown, known: object) => typeof value === "string" && Object.hasOwn(known, value);

function isMember(value: unknown): value is Member {
  return isFields(value) && typeof value.id === "string" && typeof value.title === "string" &&
    (value.mode === null || isOneOf(value.mode, MODES)) && isOneOf(value.state, STATES) &&
    (value.kind === null || isOneOf(value.kind, KINDS)) && typeof value.activity === "string" &&
    typeof value.since === "string" && typeof value.url === "string";
}

export function parseObservation(value: unknown): Observation {
  if (!isFields(value) || typeof value.root !== "string" || !Array.isArray(value.sessions) ||
    value.sessions.length > MAX_LIVE_DESKS || !value.sessions.every(isMember) || !isCount(value.overflow) ||
    !isFields(value.counts) || !["needsYou", "error", "working", "idle"].every(key => isCount((value.counts as Fields)[key]))) {
    throw new Error("Invalid office snapshot");
  }
  return value as Observation;
}

export function needsYou({ state }: Pick<Member, "state">): boolean {
  return state === "question" || state === "permission" || state === "plan-ready";
}

export function noticeFor({ state, kind }: Pick<Member, "state" | "kind">): LiveNoticeActivity | null {
  switch (state) {
    case "idle": return null;
    case "question": return "question";
    case "permission": return "blocked";
    case "plan-ready": return "plan";
    case "error": return "error";
    case "working": return kind ?? "thinking";
    default: {
      const unknown: never = state;
      throw new Error(`Unknown session state: ${unknown}`);
    }
  }
}

export function sessionLink(url: string): string | null {
  return SESSION_LINK.test(url) ? url : null;
}

export function initials(title: string): string {
  return title.split(/\s+/).filter(Boolean).slice(0, 2).map(word => [...word][0].toUpperCase()).join("") || "?";
}

export function newAgent(id: number): Agent {
  return { id, state: "idle", x: 100, z: 100, target: { x: 100, z: 100 },
    route: [], workLeft: 0, workTotal: 0, visitedContext: false };
}

/** Keep visible agents at their desks when heartbeat priority changes. */
export function arrangeObservation(
  previous: readonly Member[], agents: readonly Agent[], incoming: readonly Member[],
): { members: Member[]; agents: Agent[] } {
  const fresh = new Map(incoming.map(member => [member.id, member]));
  if (fresh.size !== incoming.length) throw new Error("Duplicate observed session ID.");
  const previousAgents = new Map(previous.map((member, index) => [member.id, agents[index]]));
  const members: Member[] = [];
  for (const member of previous) {
    const updated = fresh.get(member.id);
    if (updated) {
      members.push(updated);
      fresh.delete(member.id);
    }
  }
  members.push(...fresh.values());
  const nextAgents = members.map((member, index) => {
    const agent = previousAgents.get(member.id) ?? newAgent(index);
    agent.id = index;
    return agent;
  });
  return { members, agents: nextAgents };
}
