/**
 * Text similarity utilities shared across modules.
 */

/**
 * Computes Jaccard similarity between two texts based on tokenized words.
 * Words are lowercased and split on whitespace/punctuation.
 */
export function jaccardSimilarity(textA: string, textB: string): number {
  const tokenize = (t: string): Set<string> =>
    new Set(
      t
        .toLowerCase()
        .split(/[\s,.!?;:'"()\[\]{}<>\/\\|@#$%^&*+=~`]+/)
        .filter((w) => w.length > 0),
    );

  const setA = tokenize(textA);
  const setB = tokenize(textB);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
