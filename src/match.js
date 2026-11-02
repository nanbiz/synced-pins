// Scores how well a query matches a label, for ranking suggestions: an exact
// match beats any prefix match, which beats any match of the query's letters
// in order. Within those, letters at word starts and runs of consecutive
// letters count more, and gaps count against. Null means no match.
const EXACT = 1_000_000;
const PREFIX = 100_000;

export function matchScore(query, label) {
  const q = query.trim().toLowerCase();
  const text = label.toLowerCase();
  if (!q) return null;
  if (text === q) return EXACT;
  if (text.startsWith(q)) return PREFIX + q.length;
  let score = 0;
  let run = 0;
  let at = 0;
  for (const letter of q) {
    if (letter === ' ') continue;
    const found = text.indexOf(letter, at);
    if (found === -1) return null;
    const gap = found - at;
    run = gap === 0 ? run + 1 : 1;
    const wordStart = found === 0 || /[\s\-_/.:]/.test(text[found - 1]);
    score += 10 + (wordStart ? 15 : 0) + 20 * (run - 1) - Math.min(gap, 10);
    at = found + 1;
  }
  return score;
}

// Whether every word of the query appears somewhere in the text.
export function containsWords(query, text) {
  const haystack = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}
