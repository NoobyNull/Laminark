import { describe, it, expect } from 'vitest';
import { estimateTokens, enforceTokenBudget } from '../../mcp/token-budget.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns ceil(length/4) for short text', () => {
    // "hello" is 5 chars => ceil(5/4) = 2
    expect(estimateTokens('hello')).toBe(2);
  });

  it('returns ceil(length/4) for longer text', () => {
    const text = 'a'.repeat(100);
    // 100 chars => ceil(100/4) = 25
    expect(estimateTokens(text)).toBe(25);
  });
});

describe('enforceTokenBudget', () => {
  it('returns all items when under budget', () => {
    const items = ['short one', 'short two', 'short three'];
    const result = enforceTokenBudget(items, (item) => item, 2000);

    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(3);
  });

  it('truncates when items exceed budget', () => {
    // Each item is ~100 tokens (400 chars), 100 items = ~10000 tokens
    const items = Array.from({ length: 100 }, (_, i) => 'x'.repeat(400) + i);
    const result = enforceTokenBudget(items, (item) => item, 2000);

    expect(result.truncated).toBe(true);
    expect(result.items.length).toBeLessThan(100);
  });

  it('always includes at least 1 item even if it exceeds budget', () => {
    // One huge item that exceeds the budget
    const items = ['x'.repeat(20000)];
    const result = enforceTokenBudget(items, (item) => item, 2000);

    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(1);
  });

  it('reserves 100 tokens for metadata', () => {
    // Budget 2000, effective budget = 1900 tokens
    // Each item: 1900 * 4 = 7600 chars => 1900 tokens exactly
    const exactFitItem = 'a'.repeat(7600);
    const result = enforceTokenBudget([exactFitItem], (item) => item, 2000);
    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(1);

    // Adding a second tiny item should trigger truncation because first fills budget
    const tinyItem = 'b';
    const result2 = enforceTokenBudget(
      [exactFitItem, tinyItem],
      (item) => item,
      2000,
    );
    expect(result2.truncated).toBe(true);
    expect(result2.items).toHaveLength(1);
  });

  it('respects custom budget parameter', () => {
    // Budget 500, effective = 400 tokens = 1600 chars
    // Items totaling > 1600 chars
    const items = Array.from({ length: 10 }, () => 'x'.repeat(400));
    const result = enforceTokenBudget(items, (item) => item, 500);

    expect(result.truncated).toBe(true);
    expect(result.items.length).toBeLessThan(10);
  });

  it('returns empty when no items provided', () => {
    const result = enforceTokenBudget([], (item: string) => item, 2000);

    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(0);
    expect(result.tokenEstimate).toBe(0);
  });
});
