// The advisor's Canadian tax library: entries written from the official
// sources (the Income Tax Act on Justice Laws, CRA guides and folios,
// canada.ca and saskatchewan.ca program pages), each with its citation, the
// tax year its figures were checked for, and the pages they were checked
// on. The advisor searches it before it says anything about tax, and quotes
// the citation. Refresh it every year when the new limits and rates are out.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let cache = null;

export function libraryEntries() {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(join(here, 'taxlib.json'), 'utf8'));
    } catch {
      cache = [];
    }
  }
  return cache;
}
export const setLibraryForTests = (entries) => { cache = entries; };

const STOP = new Set('a an and are as at be by can do does for from how i in is it my of on or the to what when which with you your'.split(' '));
const SYNONYM = { depreciation: 'cca', depreciate: 'cca', 'write-off': 'cca', writeoff: 'cca', kids: 'children', wife: 'spouse', husband: 'spouse' };
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}.%$]+/gu, ' ').split(' ')
  .map((w) => w.replace(/^[.]+|[.]+$/g, '')).filter((w) => w && !STOP.has(w))
  .map((w) => SYNONYM[w] || w)
  // A crude stem, so "incorporate" finds "incorporating" and "deferral" finds "deferred".
  .map((w) => (/^[a-z]{7,}$/.test(w) ? w.slice(0, 6) : w));

/** The library's topics, with how many entries each has. */
export function libraryTopics() {
  const t = {};
  for (const e of libraryEntries()) t[e.topic] = (t[e.topic] || 0) + 1;
  return t;
}

/**
 * Best entries for a question: words in the title count most, then the
 * citation, then the text. `topic` narrows the search. Returns up to `limit`
 * entries in full (text cut at 3,000 characters).
 */
export function searchLibrary(query, { topic = null, limit = 4 } = {}) {
  const q = words(query);
  const list = libraryEntries().filter((e) => !topic || e.topic === topic);
  if (!q.length) return list.slice(0, limit).map(shape);
  const scored = list.map((e) => {
    const title = words(e.title);
    const cite = words(e.cite);
    const text = words(e.text);
    let s = 0;
    for (const w of q) {
      if (title.includes(w)) s += 6;
      if (cite.includes(w)) s += 3;
      if (e.id.includes(w)) s += 3;
      const n = text.filter((x) => x === w).length;
      s += Math.min(n, 4);
    }
    return { e, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => shape(x.e));
}

function shape(e) {
  return {
    id: e.id, title: e.title, topic: e.topic, tax_year: e.tax_year, status: e.status, verified: e.verified !== false,
    cite: e.cite, text: String(e.text || '').slice(0, 3000), sources: (e.sources || []).slice(0, 3),
  };
}
