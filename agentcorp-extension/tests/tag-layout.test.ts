import assert from "node:assert/strict";
import { test } from "node:test";
import { TAG_ANCHOR_INSET, TAG_GAP, TAG_NUDGES, placeTags, type TagBox, type TagPosition } from "../src/tag-layout";

const viewport = { width: 800, height: 600 };
type Agent = { bottom?: number; top?: number; reach?: number; width?: number; height?: number };
const tag = (id: string, x: number, { bottom = 300, top = bottom - 60, reach = 12, width = 100, height = 30 }: Agent = {}):
  TagBox => ({ id, x, width, height, agent: { left: x - reach, right: x + reach, top, bottom } });
type Shown = TagBox & TagPosition;
const apart = (a: Shown, b: Shown) =>
  a.left + a.width + TAG_GAP <= b.left + 1e-6 || b.left + b.width + TAG_GAP <= a.left + 1e-6 ||
  a.top + a.height + TAG_GAP <= b.top + 1e-6 || b.top + b.height + TAG_GAP <= a.top + 1e-6;

test("a lone tag centers under its agent", () => {
  assert.deepEqual([...placeTags([tag("solo", 200)], viewport)], [["solo", { left: 150, top: 300, side: "below" }]]);
});

test("neighbors share the shift needed to clear each other", () => {
  const placed = placeTags([tag("first", 200), tag("second", 280)], viewport);
  const first = 150 - (20 + TAG_GAP) / 2;
  assert.deepEqual(placed.get("first"), { left: first, top: 300, side: "below" });
  assert.deepEqual(placed.get("second"), { left: first + 100 + TAG_GAP, top: 300, side: "below" });
});

test("wide tags at neighboring desks both stay under their agents", () => {
  const placed = placeTags([tag("question", 300, { width: 150 }), tag("permission", 370, { width: 150 })], viewport);
  const question = placed.get("question");
  const permission = placed.get("permission");
  assert.ok(question && permission);
  assert.equal(question.side, "below");
  assert.equal(permission.side, "below");
  assert.ok(question.left + 150 + TAG_GAP <= permission.left + 1e-6);
  assert.ok(question.left + 150 - TAG_ANCHOR_INSET >= 300 && permission.left + TAG_ANCHOR_INSET <= 370);
});

test("a tag with no room beside its neighbors flips above its agent", () => {
  const placed = placeTags([tag("question", 300, { width: 150 }), tag("permission", 370, { width: 150 }),
    tag("plan", 440, { width: 150 })], viewport);
  assert.deepEqual(placed.get("plan"), { left: 365, top: 210, side: "above" });
});

test("a tag slides sideways to keep clear of the agent in front of it", () => {
  const placed = placeTags([tag("back", 300), tag("front", 250, { bottom: 345 })], viewport);
  assert.deepEqual(placed.get("back"), { left: 262, top: 300, side: "below" });
  assert.deepEqual(placed.get("front"), { left: 200, top: 345, side: "below" });
});

test("a tag flips above when the agent in front of it stands right under it", () => {
  const placed = placeTags([tag("back", 300), tag("front", 296, { bottom: 345 })], viewport);
  assert.deepEqual(placed.get("back"), { left: 250, top: 210, side: "above" });
  assert.deepEqual(placed.get("front"), { left: 246, top: 345, side: "below" });
});

test("a later tag never pushes an earlier tag onto another agent", () => {
  const placed = placeTags([tag("first", 200), tag("second", 140), tag("front", 262, { bottom: 340 })], viewport);
  assert.deepEqual(placed.get("first"), { left: 150, top: 300, side: "below" });
  assert.deepEqual(placed.get("second"), { left: 90, top: 210, side: "above" });
});

test("with no clear spot a tag still shows, and the row under it moves down a little", () => {
  const placed = placeTags([tag("upper", 200, { bottom: 60, top: 0 }), tag("lower", 200, { bottom: 84, top: 24 })],
    viewport);
  assert.deepEqual(placed.get("upper"), { left: 150, top: 60, side: "below" });
  assert.deepEqual(placed.get("lower"), { left: 150, top: 96, side: "below" });
});

test("input order decides which tags show when agents crowd one spot", () => {
  const crowd = [tag("first", 200), tag("second", 203), tag("third", 206)];
  const forward = placeTags(crowd, viewport);
  assert.equal(forward.get("first")?.side, "below");
  assert.equal(forward.get("second")?.side, "above");
  assert.equal(forward.has("third"), false);
  const reversed = placeTags([...crowd].reverse(), viewport);
  assert.equal(reversed.get("third")?.side, "below");
  assert.equal(reversed.get("second")?.side, "above");
  assert.equal(reversed.has("first"), false);
});

test("tags in separate rows don't block each other", () => {
  const placed = placeTags([tag("upper", 200), tag("lower", 262, { bottom: 300 + 30 + TAG_GAP })], viewport);
  assert.deepEqual(placed.get("upper"), { left: 150, top: 300, side: "below" });
  assert.deepEqual(placed.get("lower"), { left: 212, top: 335, side: "below" });
});

test("tags near a side stay in view without leaving their agent", () => {
  const placed = placeTags([tag("left", 20), tag("right", 790)], viewport);
  assert.deepEqual(placed.get("left"), { left: 0, top: 300, side: "below" });
  assert.deepEqual(placed.get("right"), { left: 700, top: 300, side: "below" });
});

test("a tag shows only where all of it fits on screen", () => {
  assert.equal(placeTags([tag("gone", -40)], viewport).size, 0);
  assert.deepEqual(placeTags([tag("low", 400, { bottom: 580 })], viewport).get("low"),
    { left: 350, top: 490, side: "above" });
  assert.equal(placeTags([tag("cramped", 400, { bottom: 590, top: 20 })], viewport).size, 0);
});

test("a crowded office never shows overlapping tags or a tag away from its agent", () => {
  let seed = 7;
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  for (let round = 0; round < 50; round++) {
    const tags = Array.from({ length: 16 }, (_, index) => {
      const bottom = random() * 640 - 20;
      return tag(`agent-${index}`, random() * 820 - 10, { bottom, top: bottom - 70 - random() * 40,
        width: 40 + random() * 110, height: 18 + random() * 20 });
    });
    const placed = placeTags(tags, viewport);
    const shown = tags.flatMap(box => {
      const position = placed.get(box.id);
      return position ? [{ ...box, ...position }] : [];
    });
    assert.ok(shown.length > 1);
    for (const box of shown) {
      const inset = Math.min(TAG_ANCHOR_INSET, box.width / 2);
      const nudge = box.side === "below" ? box.top - box.agent.bottom : box.agent.top - box.height - box.top;
      assert.ok(TAG_NUDGES.includes(nudge), `${box.id} sits away from its agent`);
      assert.ok(box.left >= -1e-6 && box.left + box.width <= viewport.width + 1e-6);
      assert.ok(box.top >= 0 && box.top + box.height <= viewport.height);
      assert.ok(box.x >= box.left + inset - 1e-6 && box.x <= box.left + box.width - inset + 1e-6);
      for (const other of shown) if (other !== box) assert.ok(apart(box, other), `${box.id} overlaps ${other.id}`);
    }
  }
});
