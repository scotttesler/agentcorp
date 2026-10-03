export type Rect = { left: number; top: number; right: number; bottom: number };
export type TagBox = { id: string; x: number; width: number; height: number; agent: Rect };
export type TagSide = "below" | "above";
export type TagPosition = { left: number; top: number; side: TagSide };

export const TAG_GAP = 5;
export const TAG_ANCHOR_INSET = 10;
export const TAG_NUDGES = [0, 6, 12];
const EPSILON = 1e-6;

type Slot = {
  id: string; x: number; top: number; bottom: number; width: number;
  lowest: number; highest: number; order: number; side: TagSide;
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function arrange(slots: readonly Slot[]): number[] | null {
  const count = slots.length;
  const blocks = (a: number, b: number) =>
    slots[a].top < slots[b].bottom + TAG_GAP - EPSILON && slots[b].top < slots[a].bottom + TAG_GAP - EPSILON;
  const room = (index: number) => slots[index].width + TAG_GAP;
  const sweep = (start: (index: number) => number, forward: boolean) => {
    const lefts = new Array<number>(count);
    for (let step = 0; step < count; step++) {
      const index = forward ? step : count - 1 - step;
      lefts[index] = start(index);
      for (let other = 0; other < count; other++) {
        if (forward && other < index && blocks(other, index)) {
          lefts[index] = Math.max(lefts[index], lefts[other] + room(other));
        } else if (!forward && other > index && blocks(index, other)) {
          lefts[index] = Math.min(lefts[index], lefts[other] - room(index));
        }
      }
    }
    return lefts;
  };
  const earliest = sweep(index => slots[index].lowest, true);
  if (earliest.some((left, index) => left > slots[index].highest + EPSILON)) return null;
  const latest = sweep(index => slots[index].highest, false);
  const preferred = slots.map((slot, index) => clamp(slot.x - slot.width / 2, earliest[index], latest[index]));
  const rightward = sweep(index => preferred[index], true);
  const leftward = sweep(index => preferred[index], false);
  return rightward.map((left, index) => (left + leftward[index]) / 2);
}

export function placeTags(tags: readonly TagBox[], viewport: { width: number; height: number }) {
  let accepted: Slot[] = [];
  let lefts: number[] = [];
  tags.forEach((tag, order) => {
    const inset = Math.min(TAG_ANCHOR_INSET, tag.width / 2);
    const lowest = Math.max(0, tag.x + inset - tag.width);
    const highest = Math.min(viewport.width - tag.width, tag.x - inset);
    if (lowest > highest + EPSILON) return;
    const candidates = [
      ...TAG_NUDGES.map(nudge => ({ top: tag.agent.bottom + nudge, side: "below" as const })),
      ...TAG_NUDGES.map(nudge => ({ top: tag.agent.top - tag.height - nudge, side: "above" as const })),
    ].filter(({ top }) => top >= 0 && top + tag.height <= viewport.height);
    const clearOfAgents = (top: number, bottom: number) => {
      let low = lowest;
      let high = highest;
      for (const { agent } of tags) {
        if (agent.top >= bottom || top >= agent.bottom) continue;
        if (agent.left >= tag.x) high = Math.min(high, agent.left - tag.width);
        else if (agent.right <= tag.x) low = Math.max(low, agent.right);
        else return null;
      }
      return { lowest: low, highest: high };
    };
    for (const clear of [true, false]) {
      for (const { top, side } of candidates) {
        const bounds = clear ? clearOfAgents(top, top + tag.height) : { lowest, highest };
        if (!bounds) continue;
        const slot: Slot = { id: tag.id, x: tag.x, top, bottom: top + tag.height, width: tag.width,
          ...bounds, order, side };
        const trial = [...accepted, slot].sort((a, b) => a.x - b.x || a.order - b.order);
        const arranged = arrange(trial);
        if (!arranged) continue;
        accepted = trial;
        lefts = arranged;
        return;
      }
    }
  });
  return new Map<string, TagPosition>(accepted.map((slot, index) =>
    [slot.id, { left: lefts[index], top: slot.top, side: slot.side }]));
}
