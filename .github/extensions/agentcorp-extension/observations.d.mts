import type { Counts } from "./presence.mjs";
import type { Kind, Mode, State } from "./status.mjs";

export type Observed = {
  id: string;
  title: string;
  mode: Mode | null;
  state: State;
  kind: Kind | null;
  activity: string;
  since: string;
  url: string;
};
export const MAX_DESKS: number;
export function snapshot(root: string, now?: number): Promise<{
  root: string;
  sessions: Observed[];
  overflow: number;
  counts: Counts;
}>;
