/** Local BM25 candidate generation; no embeddings or provider requests. */
export function tokens(text: string): string[] {
  return text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [];
}
export function lexicalRank<T>(query: string, rows: T[], document: (row: T) => string): T[] {
  const terms = [...new Set(tokens(query))];
  const docs = rows.map(row => {
    const words = tokens(document(row));
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { row, length: words.length, counts };
  });
  const average = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1) || 1;
  const weights = new Map(terms.map(t => {
    const df = docs.filter(d => d.counts.has(t)).length;
    return [t, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
  }));
  return docs.map((d, index) => ({ row: d.row, index, score: terms.reduce((score, term) => {
    const count = d.counts.get(term) ?? 0;
    return score + weights.get(term)! * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * d.length / average));
  }, 0) })).sort((a, b) => b.score - a.score || a.index - b.index).map(d => d.row);
}

/** Preserve explicitly named symbols before approximate natural-language matching. */
export function rankSymbols<T extends { id: string; signature: string }>(query: string, rows: T[]): T[] {
  const identifiers = new Set(query.match(/[A-Za-z_]\w*/g) ?? []);
  const exact = (row: T) => {
    const name = row.id.split(':').at(-1)!.split('.').at(-1)!;
    return name.length >= 4 && identifiers.has(name) && (name.includes('_') || query.includes(name + '('));
  };
  const ranked = lexicalRank(query, rows, row => row.id + '\n' + row.signature);
  return [...ranked.filter(exact), ...ranked.filter(row => !exact(row))];
}
