import { officeHome, readRoster } from "./presence.mjs";

export const MAX_DESKS = 16;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function validId(id) {
  if (typeof id !== "string" || !idPattern.test(id)) throw new Error("Invalid session ID.");
  return id;
}

export async function snapshot(root, now = Date.now()) {
  validId(root);
  const roster = await readRoster(officeHome(), { now });
  if (roster.problem) throw new Error(roster.problem);
  const sessions = roster.agents.slice(0, MAX_DESKS).map(({ sessionId, title, mode, state, kind, activity, since, url }) =>
    ({ id: sessionId, title, mode, state, kind, activity, since, url }));
  return { root, sessions, overflow: Math.max(0, roster.agents.length - MAX_DESKS), counts: roster.counts };
}
