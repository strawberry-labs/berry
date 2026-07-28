export type RankedRetrievalItem = {
  chunkId: string;
  sourceId: string;
  text: string;
  tokenEstimate: number;
  authority?: number;
  createdAt?: string;
};

export type FusedRetrievalItem<T extends RankedRetrievalItem = RankedRetrievalItem> = T & {
  ftsRank: number | null;
  vectorRank: number | null;
  fusedScore: number;
};

export function reciprocalRankFusion<T extends RankedRetrievalItem>(
  fullText: readonly T[],
  vector: readonly T[],
  options: { rankConstant?: number; authorityWeight?: number; recencyWeight?: number; now?: Date } = {},
): FusedRetrievalItem<T>[] {
  const rankConstant = options.rankConstant ?? 60;
  const authorityWeight = options.authorityWeight ?? 0.02;
  const recencyWeight = options.recencyWeight ?? 0.005;
  const now = options.now ?? new Date();
  const fused = new Map<string, FusedRetrievalItem<T>>();
  const add = (item: T, rank: number, lane: "fts" | "vector") => {
    const current = fused.get(item.chunkId) ?? {
      ...item,
      ftsRank: null,
      vectorRank: null,
      fusedScore: 0,
    };
    if (lane === "fts") current.ftsRank = rank;
    else current.vectorRank = rank;
    current.fusedScore += 1 / (rankConstant + rank);
    fused.set(item.chunkId, current);
  };
  fullText.forEach((item, index) => add(item, index + 1, "fts"));
  vector.forEach((item, index) => add(item, index + 1, "vector"));
  for (const item of fused.values()) {
    item.fusedScore += Math.max(0, Math.min(1, item.authority ?? 0.5)) * authorityWeight;
    if (item.createdAt) {
      const ageDays = Math.max(0, (now.getTime() - Date.parse(item.createdAt)) / 86_400_000);
      item.fusedScore += (1 / (1 + ageDays / 30)) * recencyWeight;
    }
  }
  return [...fused.values()].sort((left, right) =>
    right.fusedScore - left.fusedScore ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.chunkId.localeCompare(right.chunkId));
}

export function selectRetrievalCandidates<T extends FusedRetrievalItem>(
  candidates: readonly T[],
  options: { tokenBudget: number; maxPerSource?: number },
): { selected: T[]; tokensSelected: number } {
  const selected: T[] = [];
  const normalizedTexts = new Set<string>();
  const sourceCounts = new Map<string, number>();
  const maxPerSource = options.maxPerSource ?? 3;
  let tokensSelected = 0;
  for (const candidate of candidates) {
    if (candidate.tokenEstimate <= 0) continue;
    if ((sourceCounts.get(candidate.sourceId) ?? 0) >= maxPerSource) continue;
    const normalized = candidate.text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (!normalized || normalizedTexts.has(normalized)) continue;
    if (tokensSelected + candidate.tokenEstimate > options.tokenBudget) continue;
    selected.push(candidate);
    normalizedTexts.add(normalized);
    sourceCounts.set(candidate.sourceId, (sourceCounts.get(candidate.sourceId) ?? 0) + 1);
    tokensSelected += candidate.tokenEstimate;
  }
  return { selected, tokensSelected };
}
