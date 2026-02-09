import { describe, it, expect } from 'vitest';
import {
  cosineDistance,
  TopicShiftDetector,
  type TopicShiftResult,
} from '../topic-detector.js';

// ---------------------------------------------------------------------------
// cosineDistance utility function
// ---------------------------------------------------------------------------

describe('cosineDistance', () => {
  it('returns 0 for identical vectors', () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineDistance(a, b)).toBeCloseTo(0, 10);
  });

  it('returns 1 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineDistance(a, b)).toBeCloseTo(1, 10);
  });

  it('returns 2 for opposite vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineDistance(a, b)).toBeCloseTo(2, 10);
  });

  it('returns small distance for similar vectors', () => {
    const a = [1, 0, 0];
    const b = [0.95, 0.05, 0];
    const d = cosineDistance(a, b);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(0.3);
  });

  it('handles zero vector gracefully (returns 0, no NaN)', () => {
    const a = [0, 0, 0];
    const b = [1, 0, 0];
    const d = cosineDistance(a, b);
    expect(d).toBe(0);
    expect(Number.isNaN(d)).toBe(false);
  });

  it('handles both zero vectors gracefully', () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    const d = cosineDistance(a, b);
    expect(d).toBe(0);
    expect(Number.isNaN(d)).toBe(false);
  });

  it('is symmetric: distance(a,b) === distance(b,a)', () => {
    const a = [0.5, 0.3, 0.8];
    const b = [0.1, 0.9, 0.4];
    expect(cosineDistance(a, b)).toBeCloseTo(cosineDistance(b, a), 10);
  });

  it('handles high-dimensional vectors', () => {
    const dim = 384;
    const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const b = Array.from({ length: dim }, (_, i) => Math.cos(i));
    const d = cosineDistance(a, b);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(2);
    expect(Number.isNaN(d)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TopicShiftDetector
// ---------------------------------------------------------------------------

describe('TopicShiftDetector', () => {
  it('reports no shift on first observation (no previous embedding)', () => {
    const detector = new TopicShiftDetector();
    const result = detector.detect([1, 0, 0]);

    expect(result.shifted).toBe(false);
    expect(result.distance).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.previousEmbedding).toBeNull();
    expect(result.currentEmbedding).toEqual([1, 0, 0]);
    expect(result.threshold).toBe(0.3);
  });

  it('detects shift when distance exceeds default threshold (0.3)', () => {
    const detector = new TopicShiftDetector();
    detector.detect([1, 0, 0]); // first observation
    const result = detector.detect([0, 1, 0]); // orthogonal = distance 1.0

    expect(result.shifted).toBe(true);
    expect(result.distance).toBeCloseTo(1.0, 5);
    expect(result.threshold).toBe(0.3);
  });

  it('does NOT detect shift when distance is below threshold', () => {
    const detector = new TopicShiftDetector();
    detector.detect([1, 0, 0]); // first observation
    const result = detector.detect([0.95, 0.05, 0]); // very similar

    expect(result.shifted).toBe(false);
    expect(result.distance).toBeLessThan(0.3);
  });

  it('handles identical consecutive embeddings (no shift)', () => {
    const detector = new TopicShiftDetector();
    detector.detect([1, 0, 0]);
    const result = detector.detect([1, 0, 0]);

    expect(result.shifted).toBe(false);
    expect(result.distance).toBeCloseTo(0, 10);
    expect(result.confidence).toBe(0);
  });

  it('handles zero vector embedding gracefully', () => {
    const detector = new TopicShiftDetector();
    detector.detect([1, 0, 0]);
    const result = detector.detect([0, 0, 0]);

    expect(result.shifted).toBe(false);
    expect(result.distance).toBe(0);
    expect(Number.isNaN(result.distance)).toBe(false);
    expect(Number.isNaN(result.confidence)).toBe(false);
  });

  it('uses custom threshold', () => {
    const detector = new TopicShiftDetector({ threshold: 0.5 });
    detector.detect([1, 0, 0]);

    // Distance ~0.293 for this vector -- below 0.5, so no shift
    const noShift = detector.detect([0.8, 0.6, 0]);
    expect(noShift.shifted).toBe(false);
    expect(noShift.threshold).toBe(0.5);

    // Now something very different -- orthogonal, distance 1.0 > 0.5
    const shifted = detector.detect([0, 0, 1]);
    expect(shifted.shifted).toBe(true);
    expect(shifted.threshold).toBe(0.5);
  });

  it('correctly calculates confidence (how far past threshold)', () => {
    const detector = new TopicShiftDetector({ threshold: 0.3 });
    detector.detect([1, 0, 0]);

    // Orthogonal: distance 1.0, confidence = min((1.0-0.3)/0.3, 1.0) = min(2.33, 1.0) = 1.0
    const result = detector.detect([0, 1, 0]);
    expect(result.shifted).toBe(true);
    expect(result.confidence).toBeCloseTo(1.0, 5);
  });

  it('confidence is 0 when not shifted', () => {
    const detector = new TopicShiftDetector();
    detector.detect([1, 0, 0]);
    const result = detector.detect([0.99, 0.01, 0]);

    expect(result.shifted).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it('reset() clears last embedding state', () => {
    const detector = new TopicShiftDetector();
    detector.detect([1, 0, 0]); // first
    detector.detect([0, 1, 0]); // second (shift)

    detector.reset();

    // After reset, next detect is treated as first observation
    const result = detector.detect([0, 0, 1]);
    expect(result.shifted).toBe(false);
    expect(result.previousEmbedding).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('getThreshold() returns current threshold', () => {
    const detector = new TopicShiftDetector({ threshold: 0.45 });
    expect(detector.getThreshold()).toBe(0.45);
  });

  it('setThreshold() updates threshold with bounds [0.05, 0.95]', () => {
    const detector = new TopicShiftDetector();

    detector.setThreshold(0.6);
    expect(detector.getThreshold()).toBe(0.6);

    // Below minimum
    detector.setThreshold(0.01);
    expect(detector.getThreshold()).toBe(0.05);

    // Above maximum
    detector.setThreshold(1.5);
    expect(detector.getThreshold()).toBe(0.95);
  });

  it('updates lastEmbedding after each detect call', () => {
    const detector = new TopicShiftDetector();
    detector.detect([1, 0, 0]);
    const result = detector.detect([0, 1, 0]);

    // previousEmbedding should be the first observation
    expect(result.previousEmbedding).toEqual([1, 0, 0]);
    expect(result.currentEmbedding).toEqual([0, 1, 0]);
  });

  it('tracks topic shifts across multiple sequential observations', () => {
    const detector = new TopicShiftDetector({ threshold: 0.3 });

    // Observation 1: no prior
    const r1 = detector.detect([1, 0, 0]);
    expect(r1.shifted).toBe(false);

    // Observation 2: very similar
    const r2 = detector.detect([0.98, 0.02, 0]);
    expect(r2.shifted).toBe(false);

    // Observation 3: topic shift (orthogonal)
    const r3 = detector.detect([0, 1, 0]);
    expect(r3.shifted).toBe(true);

    // Observation 4: similar to new topic
    const r4 = detector.detect([0.02, 0.98, 0]);
    expect(r4.shifted).toBe(false);

    // Observation 5: another shift
    const r5 = detector.detect([0, 0, 1]);
    expect(r5.shifted).toBe(true);
  });
});
