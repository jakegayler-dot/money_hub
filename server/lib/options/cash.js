// His option profit and loss, from the trades already in Money Hub (Jake, Nov 17: "it doesnt show my option profit and loss.
// it should look like any asset that produces cash"; what he wants to see: "You've collected US$673 in call premium and paid
// US$1,551 net for puts ... Calls: US$558 on NVDA and US$115 on SpaceX"). His brokerage trades are ordinary transactions under
// one "Investment buy/sell" category, so each is sorted here by the words in it: call premium, put premium, the shares, or
// other (interest, fees), and which stock. His own correction (options_cash_tags) wins, and a word he names files every entry
// that mentions it (aliases: "SpaceX" → its symbol). The transactions are never changed; the amounts are his real cash.
import { pool, getSetting } from '../../db.js';
import { toISODate } from '../dates.js';

const KEY = 'covered_call_cash';
export const KINDS = ['call', 'put', 'stock', 'other'];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const SYM = /^[A-Z]{1,6}$/;

export async function getSource() {
  const s = (await getSetting(KEY, {})) || {};
  return {
    account_ids: Array.isArray(s.account_ids) ? s.account_ids.map(Number).filter(Number.isInteger) : [],
    currency: s.currency === 'CAD' ? 'CAD' : 'USD', // what the entries' amounts are in (his broker's are US$)
    aliases: s.aliases && typeof s.aliases === 'object' ? s.aliases : {},
  };
}
async function saveSourceRaw(s) {
  await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [KEY, JSON.stringify(s)]);
  return s;
}
export async function saveSource(input = {}) {
  const cur = await getSource();
  const next = { ...cur };
  if (input.account_ids !== undefined) next.account_ids = (Array.isArray(input.account_ids) ? input.account_ids : []).map(Number).filter(Number.isInteger).slice(0, 10);
  if (input.currency !== undefined) next.currency = input.currency === 'CAD' ? 'CAD' : 'USD';
  return saveSourceRaw(next);
}

const OCC = /\b([A-Z]{1,6})\s?(\d{6})([CP])(\d{8})\b/;
const OTHER = /\b(DIVIDENDS?|INTEREST|FEES?|COMMISSIONS?|DEPOSITS?|WITHDRAW\w*|TRANSFERS?|CONTRIBUTIONS?|FX|EXCHANGE|CONVERSION)\b/;
const STOCK = /\b(SHARES?|STOCK|BOUGHT|BUY|SOLD|SELL|PURCHASED?)\b/;

const NOT_A_SYMBOL = new Set(('BUY SELL SOLD BOUGHT CALL CALLS PUT PUTS TO OPEN CLOSE STO BTO STC BTC USD CAD US JAN FEB MAR APR MAY JUN JUL AUG SEP SEPT OCT NOV DEC '
  + 'ETF INC CORP LTD THE AT FOR OF AND ON IN ROLL ROLLED DEBIT CREDIT OPTION OPTIONS SHARE SHARES STOCK PREMIUM FEE FEES DTE EXP EXPIRY STRIKE NET COVERED '
  + 'LONG SHORT LIMIT MARKET ORDER FILLED TRADE QTY PRICE TFSA RRSP FHSA MARGIN CASH ACCOUNT').split(' '));
/** One entry's words → { kind, symbol }; either can be null (not sure: he sorts it). Pure. */
export function classify(text, known = new Set(), aliases = {}) {
  const raw = String(text || '');
  const U = raw.toUpperCase();
  let symbol = null;
  for (const [word, sym] of Object.entries(aliases)) {
    if (word && U.includes(String(word).toUpperCase()) && SYM.test(String(sym))) { symbol = String(sym); break; }
  }
  const occ = OCC.exec(U);
  if (!symbol && occ) symbol = occ[1];
  if (!symbol) {
    // A ticker as written (capitals in the text itself, or $NVDA), among the stocks the desk knows.
    const tokens = raw.match(/\$?\b[A-Z]{1,6}\b/g) || [];
    symbol = tokens.map((t) => t.replace('$', '')).find((t) => known.has(t)) || null;
  }
  const call = /\bCALLS?\b/.test(U) || /\b\d+(?:\.\d+)?\s?C\b/.test(U) || /\bC\d+(?:\.\d+)?\b/.test(U);
  const put = /\bPUTS?\b/.test(U) || /\b\d+(?:\.\d+)?\s?P\b/.test(U) || /\bP\d+(?:\.\d+)?\b/.test(U);
  if (!symbol && (call || put || STOCK.test(U))) {
    // A trade on a stock the desk doesn't know yet: the first capital-letter word that isn't a trading word.
    symbol = (raw.match(/\b[A-Z]{2,5}\b/g) || []).find((t) => !NOT_A_SYMBOL.has(t)) || null;
  }
  let kind = null;
  if (occ) kind = occ[3] === 'C' ? 'call' : 'put';
  else if (call && !put) kind = 'call';
  else if (put && !call) kind = 'put';
  else if (call && put) kind = null; // both named in one entry: his to say
  else if (OTHER.test(U)) kind = 'other';
  else if (STOCK.test(U)) kind = 'stock';
  return { kind, symbol };
}

/** The stocks the desk knows by symbol: his positions, his watchlist, the wider list, and what he has filed before. */
async function knownSymbols(extra = []) {
  const { rows } = await pool.query(`SELECT symbol FROM options_positions UNION SELECT symbol FROM options_cash_tags WHERE symbol IS NOT NULL`);
  return new Set([...rows.map((r) => r.symbol), ...extra].filter((s) => SYM.test(String(s || ''))));
}

/**
 * Every brokerage entry, sorted, and the totals: by stock (calls in, puts net, the shares' cash), overall, and what couldn't
 * be sorted. Entries come from categories named like "Investment ..." and from any account he has picked.
 */
export async function optionCash({ symbols = [] } = {}) {
  const src = await getSource();
  const { rows } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, t.review_note, p.name AS payee, a.id AS account_id, a.name AS account,
            c.name AS category, g.kind AS tag_kind, g.symbol AS tag_symbol
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN expense_categories c ON c.id = t.category_id
       LEFT JOIN expense_categories pc ON pc.id = c.parent_id
       LEFT JOIN options_cash_tags g ON g.transaction_id = t.id
      WHERE NOT COALESCE(t.is_transfer, false)
        AND (c.name ILIKE '%invest%' OR pc.name ILIKE '%invest%' OR t.account_id = ANY($1::int[]))
      ORDER BY t.date DESC, t.id DESC
      LIMIT 3000`, [src.account_ids]);
  const known = await knownSymbols(symbols);
  const entries = rows.map((r) => {
    const words = [r.description, r.payee, r.review_note].filter(Boolean).join(' ');
    const auto = classify(words, known, src.aliases);
    const mine = KINDS.includes(r.tag_kind);
    return {
      id: r.id, date: toISODate(r.date), amount: Number(r.amount), words: words || '(no description)', account: r.account, category: r.category,
      kind: mine ? r.tag_kind : auto.kind, symbol: (mine ? r.tag_symbol : null) || auto.symbol, sorted_by: mine ? 'you' : 'words',
    };
  });
  const by = new Map();
  const blank = (symbol) => ({ symbol, calls: 0, puts: 0, stock: 0, call_entries: 0, put_entries: 0, first: null, last: null });
  for (const e of entries) {
    if (!e.kind || e.kind === 'other' || !e.symbol) continue;
    if (!by.has(e.symbol)) by.set(e.symbol, blank(e.symbol));
    const b = by.get(e.symbol);
    if (e.kind === 'call') { b.calls += e.amount; b.call_entries += 1; }
    if (e.kind === 'put') { b.puts += e.amount; b.put_entries += 1; }
    if (e.kind === 'stock') b.stock += e.amount;
    if (e.kind !== 'stock') { b.first = !b.first || e.date < b.first ? e.date : b.first; b.last = !b.last || e.date > b.last ? e.date : b.last; }
  }
  const stocks = [...by.values()].map((b) => ({ ...b, calls: r2(b.calls), puts: r2(b.puts), stock: r2(b.stock), options_net: r2(b.calls + b.puts) }))
    .sort((a, b) => Math.abs(b.calls) + Math.abs(b.puts) - (Math.abs(a.calls) + Math.abs(a.puts)));
  const unsorted = entries.filter((e) => !e.kind || (e.kind !== 'other' && !e.symbol));
  const calls = r2(stocks.reduce((a, s) => a + s.calls, 0)); const puts = r2(stocks.reduce((a, s) => a + s.puts, 0));
  const { rows: accounts } = await pool.query(`SELECT id, name FROM accounts ORDER BY name`);
  return {
    currency: src.currency, account_ids: src.account_ids, accounts, aliases: src.aliases,
    read: { entries: entries.length, categories: [...new Set(entries.map((e) => e.category).filter(Boolean))], accounts: [...new Set(entries.map((e) => e.account))] },
    totals: { calls, puts, options_net: r2(calls + puts), first: stocks.map((s) => s.first).filter(Boolean).sort()[0] || null },
    stocks, unsorted, entries,
  };
}

/** His own sorting of one entry; `word` files every entry that mentions it under the same stock from now on. */
export async function tagEntry(id, { kind, symbol, word } = {}) {
  if (!KINDS.includes(kind)) throw Object.assign(new Error('Call, put, stock or other.'), { status: 422 });
  const sym = String(symbol || '').trim().toUpperCase() || null;
  if (kind !== 'other' && !SYM.test(sym || '')) throw Object.assign(new Error('Which stock? Its symbol, like NVDA.'), { status: 422 });
  const { rowCount } = await pool.query(
    `INSERT INTO options_cash_tags (transaction_id, kind, symbol) SELECT id, $2, $3 FROM transactions WHERE id = $1
     ON CONFLICT (transaction_id) DO UPDATE SET kind = $2, symbol = $3, updated_at = now()`, [Number(id), kind, kind === 'other' ? null : sym]);
  if (!rowCount) throw Object.assign(new Error('No such entry.'), { status: 404 });
  const w = String(word || '').trim();
  if (w.length >= 3 && sym && kind !== 'other') {
    const src = await getSource();
    await saveSourceRaw({ ...src, aliases: { ...src.aliases, [w]: sym } });
  }
  return { ok: true };
}
export async function untagEntry(id) {
  await pool.query(`DELETE FROM options_cash_tags WHERE transaction_id = $1`, [Number(id)]);
  return { ok: true };
}
