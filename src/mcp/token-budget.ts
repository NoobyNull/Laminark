export const TOKEN_BUDGET = 2000;
export const FULL_VIEW_BUDGET = 4000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function enforceTokenBudget<T>(
  results: T[],
  formatResult: (item: T) => string,
  budget: number = TOKEN_BUDGET,
): { items: T[]; truncated: boolean; tokenEstimate: number } {
  const METADATA_RESERVE = 100;
  const effectiveBudget = budget - METADATA_RESERVE;
  let totalTokens = 0;
  const items: T[] = [];

  for (const result of results) {
    const formatted = formatResult(result);
    const tokens = estimateTokens(formatted);
    if (totalTokens + tokens > effectiveBudget && items.length > 0) {
      return { items, truncated: true, tokenEstimate: totalTokens };
    }
    items.push(result);
    totalTokens += tokens;
  }

  return { items, truncated: false, tokenEstimate: totalTokens };
}
