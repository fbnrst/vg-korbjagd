// Manual order of the open items. Pure logic (no DOM), covered by test/order.test.js.
//
// Each item may carry `pos`, a number. The effective position is `pos`, or `addedAt` for an item that never moved, so a list
// nobody reordered keeps today's order (oldest first) and a new item (addedAt = now, larger than any rank) lands at the end.
// A move writes ONE number on the moved item only (a transaction on that item): two people moving different items cannot
// disturb each other, and two moving the same item end with the last write. The new number is the midpoint between the
// neighbours (fractional positions). When two neighbours have run out of room (gap below MIN_GAP, after about 40 halvings from
// a gap of 1, or about 10 from a gap of 1 ms on addedAt) the open items are renumbered 1, 2, 3 ... in their current order
// (`renumber`), one write per item; a concurrent move during that moment can at worst put one item one place off,
// the next move repairs it. Checked items keep their `pos` (unchecking returns them to the old place), a deleted item that is
// restored brings its `pos` back.
export const MIN_GAP = 1e-3, POS_MIN = -1e9, POS_MAX = 1e13;

export const isPos = v => typeof v === 'number' && Number.isFinite(v) && v >= POS_MIN && v <= POS_MAX;
export const toPos = v => (v === null || v === '' || v === undefined ? null : isPos(Number(v)) ? Number(v) : null);
export const effPos = i => (isPos(i.pos) ? i.pos : Number(i.addedAt) || 0);
// Position, then age, then id: a total order, the same on every phone
export const byOrder = (a, b) => effPos(a) - effPos(b) || (a.addedAt || 0) - (b.addedAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const sortOpen = items => items.slice().sort(byOrder);

// Put `id` at insertion index `at` of the list without it. Returns { pos } (one write) or { renumber: [[id, pos], ...] }.
function planInsert(all, id, at) {
  const rest = all.filter(i => i.id !== id);
  const a = at > 0 ? effPos(rest[at - 1]) : null, b = at < rest.length ? effPos(rest[at]) : null;
  const pos = a === null ? (b === null ? 1 : b - 1) : b === null ? a + 1 : (a + b) / 2;
  if (isPos(pos) && (a === null || b === null || (b - a >= MIN_GAP && pos > a && pos < b))) return { pos };
  const moved = rest.slice(); moved.splice(at, 0, all.find(i => i.id === id));
  return { renumber: moved.map((i, n) => [i.id, n + 1]) };
}

// One step up (dir -1) or down (+1) among the visible items `visible` (the section the item sits in, or the whole list), for
// the keyboard. `open` is every open item. Returns null (nothing to do), { pos } or { renumber }.
export function planMove(open, id, dir, visible = open) {
  const all = sortOpen(open), group = sortOpen(visible);
  const g = group.findIndex(i => i.id === id);
  if (g < 0 || (dir !== -1 && dir !== 1) || !group[g + dir]) return null;
  const rest = all.filter(i => i.id !== id), k = rest.findIndex(i => i.id === group[g + dir].id);
  return planInsert(all, id, dir < 0 ? k : k + 1);
}

// A drag ended with `id` between `prevId` and `nextId` of its section (either may be null): place it right after the previous
// one (or right before the next one when it is first). Returns null when it did not change place.
export function planDrop(open, id, prevId, nextId) {
  const all = sortOpen(open), rest = all.filter(i => i.id !== id);
  if (!all.some(i => i.id === id)) return null;
  const at = prevId ? rest.findIndex(i => i.id === prevId) + 1 : nextId ? rest.findIndex(i => i.id === nextId) : -1;
  if (at < 0 || (prevId && at === 0)) return null;
  if (all.findIndex(i => i.id === id) === at) return null;
  return planInsert(all, id, at);
}
