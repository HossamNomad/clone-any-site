// lib/query-core.mjs — shared ranking function for the query CLI and quality score.
import { byKey } from './dimensions.mjs';

const TIER_RANK = { green: 0, yellow: 1, red: 2 };

/**
 * rankCards(cards, query) — filter then rank, pure (input not mutated).
 *
 * query = { artifact?, dimension?, tier?, limit? }
 *   artifact  — string; keep cards where artifactFit.includes(artifact)
 *   dimension — numeric id OR dimension key string; keep cards where dimensions.includes(id)
 *   tier      — 'green'|'yellow'|'red'; keep cards where feasibilityTier === tier
 *   limit     — slice to first N after ranking
 *
 * Rank order (ascending = better/first):
 *   1. tier rank: green(0) < yellow(1) < red(2)
 *   2. dimMatch: 0 if query.dimension provided and card includes it, else 1
 *      (after filtering all cards include it; without filter, 0 for all — effectively a no-op)
 *   3. seenOnSites.length DESC (more = higher confidence)
 *   4. slug ASC (stable tiebreak)
 */
export function rankCards(cards, query = {}) {
  const { artifact, dimension, tier, limit } = query;

  // Resolve dimension to a numeric id (may be key string or number)
  let dimId = undefined;
  if (dimension !== undefined && dimension !== null) {
    if (typeof dimension === 'string') {
      const resolved = byKey(dimension);
      dimId = resolved ? resolved.id : undefined;
    } else {
      dimId = Number(dimension);
    }
  }

  // Filter
  let filtered = cards.filter((card) => {
    if (artifact !== undefined && !card.artifactFit.includes(artifact)) return false;
    if (dimId !== undefined && !card.dimensions.includes(dimId)) return false;
    if (tier !== undefined && card.feasibilityTier !== tier) return false;
    return true;
  });

  // Sort a copy (do not mutate original array)
  const sorted = filtered.slice().sort((a, b) => {
    // 1. tier rank
    const ta = TIER_RANK[a.feasibilityTier] ?? 99;
    const tb = TIER_RANK[b.feasibilityTier] ?? 99;
    if (ta !== tb) return ta - tb;

    // 2. dimMatch (0 = includes dimId, 1 = doesn't; lower = better)
    if (dimId !== undefined) {
      const da = a.dimensions.includes(dimId) ? 0 : 1;
      const db = b.dimensions.includes(dimId) ? 0 : 1;
      if (da !== db) return da - db;
    }

    // 3. seenOnSites.length DESC (more = first)
    const sa = a.seenOnSites.length;
    const sb = b.seenOnSites.length;
    if (sa !== sb) return sb - sa;

    // 4. slug ASC
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  // Limit
  return limit !== undefined ? sorted.slice(0, limit) : sorted;
}
