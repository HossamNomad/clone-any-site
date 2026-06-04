// lib/dimensions.mjs — the single source of the 10 Design-Quality dimensions (id, key, weight)
// + the per-artifact APPLICABILITY matrix. Imported by the distillers, the query ranker, and the score.
export const DIMENSIONS = [
  { id: 1, key: 'motion', weight: 12 }, { id: 2, key: 'immersion', weight: 8 },
  { id: 3, key: 'kinetic-type', weight: 12 }, { id: 4, key: 'narrative', weight: 10 },
  { id: 5, key: 'color', weight: 10 }, { id: 6, key: 'micro-interactions', weight: 10 },
  { id: 7, key: 'perf', weight: 10 }, { id: 8, key: 'composition', weight: 12 },
  { id: 9, key: 'sound', weight: 4 }, { id: 10, key: 'finish', weight: 12 },
];
export const APPLICABILITY = {
  site: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], landing: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  dashboard: [1, 3, 5, 6, 7, 8, 10], deck: [1, 3, 4, 5, 8, 10], pdf: [3, 5, 8, 10],
};
const _byKey = new Map(DIMENSIONS.map((d) => [d.key, d]));
const _byId = new Map(DIMENSIONS.map((d) => [d.id, d]));
export const byKey = (k) => _byKey.get(k);
export const byId = (i) => _byId.get(Number(i));
