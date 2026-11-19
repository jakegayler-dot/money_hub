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
  if (!symbol) {
    // A share trade written "Buy 1,000 T at $12.53": a one-letter ticker counts there (Nov 19: TELUS is T on the TSX, and its
    // two trades sat unsorted).
    const m = /\b(?:[Bb]uy|[Ss]ell|[Bb]ought|[Ss]old|BUY|SELL|BOUGHT|SOLD)\s+[\d,]+(?:\.\d+)?\s+(?:shares?\s+(?:of\s+)?)?([A-Z]{1,5})\b/.exec(raw);
    if (m && !NOT_A_SYMBOL.has(m[1])) symbol = m[1];
  }
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
      WHERE NOT COALESCE(t.is_noncash, false) AND COALESCE(c.name, '') NOT ILIKE '%unrealized%'
        AND (
          -- His brokerage entries, transfer flag or not (Nov 19: every Wealthsimple trade had been marked a transfer, which keeps
          -- investing out of the budget, and the desk read none of them: "collected -5000 of option premium").
          ((c.name ILIKE '%invest%' OR pc.name ILIKE '%invest%')
            -- ...but money moved in or out (a deposit from chequing) is still a transfer, not a trade.
            AND (NOT COALESCE(t.is_transfer, false) OR CONCAT_WS(' ', t.description, p.name, t.review_note) !~* '\\m(deposit|transfer|withdraw|contribut)'
                 OR CONCAT_WS(' ', t.description, p.name, t.review_note) ~* '\\m(buy|bought|sell|sold|call|put|roll|open|close)'))
          OR (NOT COALESCE(t.is_transfer, false) AND (
            t.account_id = ANY($1::int[])
            -- An option fill wherever it was filed (Nov 19: the desk "can't see your option fills"): it names a call or put and a
            -- ticker, or carries an OCC option symbol.
            OR (CONCAT_WS(' ', t.description, p.name, t.review_note) ~* '\\m(calls?|puts?)\\M' AND CONCAT_WS(' ', t.description, p.name, t.review_note) ~ '\\m[A-Z]{2,6}\\M')
            OR CONCAT_WS(' ', t.description, p.name, t.review_note) ~ '\\m[A-Z]{1,6} ?[0-9]{6}[CP][0-9]{8}\\M'
            -- A bare strike and C or P ("165C") only in a brokerage account (one with Investment entries): elsewhere an invoice
            -- number before a C ("inv 13119 C and E Transport", a canola hauling payment) was read as a call on Citigroup.
            OR (CONCAT_WS(' ', t.description, p.name, t.review_note) ~ '[0-9] ?[CP]\\M'
                AND t.account_id IN (SELECT DISTINCT t2.account_id FROM transactions t2 JOIN expense_categories c2 ON c2.id = t2.category_id WHERE c2.name ILIKE '%invest%')))))
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

/**
 * The puts as insurance (Jake, Nov 17: "show me my breakeven on the puts which are essentially an insurance policy of this
 * system and therefore a fixed cost that needs to be extracted over the remaining trading days"). By stock, in US$: what the
 * puts have cost net, what the calls have paid back, what's left, the trading days to the put's expiry, what the calls must
 * bring a trading day to be even by then, what the calls open now bring, and the day that makes it even at that rate.
 * From his Money Hub entries when the stock has any; else from the positions record.
 */
export async function insurance({ now = new Date(), list: given = null, fx: givenFx } = {}) {
  const { positions, getRules, WIDE } = await import('./desk.js');
  const { usdCad } = await import('./fx.js');
  const { incomeDays, sessionDate, daysTo } = await import('./strategy.js');
  // (list and fx can be handed in: the positions need the market's prices, the rate the Bank of Canada.)
  const [list, rules, fx] = await Promise.all([given || positions(now), getRules(), givenFx === undefined ? usdCad() : givenFx]);
  const cash = await optionCash({ symbols: [...rules.watchlist, ...WIDE] });
  const toUsd = (n) => (cash.currency === 'CAD' && fx?.rate ? n / fx.rate : n);
  const open = list.filter((p) => p.status === 'open');
  const traded = cash.stocks.filter((x) => x.call_entries || x.put_entries);
  const symbols = [...new Set([...open.map((p) => p.symbol), ...traded.map((x) => x.symbol)])];
  const rows = symbols.map((symbol) => {
    const ps = open.filter((p) => p.symbol === symbol);
    const c = traded.find((x) => x.symbol === symbol) || null;
    const legs = ps.flatMap((p) => p.open_legs || []);
    const puts = legs.filter((l) => l.type === 'put' && l.side === 'long');
    const calls = legs.filter((l) => l.type === 'call' && l.side === 'short');
    const heldCost = puts.reduce((a, l) => a + Number(l.premium) * Number(l.contracts) * 100, 0);
    // What the puts cost (Nov 17, "why does it say the puts have been paid off?"): his entries' net when they account for the
    // puts he holds; when they show well under what those cost (put trades not sorted yet), the cost of the puts held, said.
    // With no entries for the stock, what the calls have paid back isn't known, so the whole cost stands: never "paid off"
    // on a guess (the positions record's option cash can be the bot's own total, not calls less puts).
    const entryPaid = c ? Math.max(0, -toUsd(c.puts)) : 0;
    const basis = !c ? 'positions' : heldCost > 0 && entryPaid < heldCost * 0.6 ? 'held' : 'entries';
    const paid = basis === 'entries' ? entryPaid : heldCost;
    if (!(paid > 0)) return null;
    const collected = c ? Math.max(0, toUsd(c.calls)) : null;
    const expiry = puts.map((l) => l.expiry).filter((e) => daysTo(e, now) > 0).sort().at(-1) || null;
    const daysLeft = expiry ? incomeDays(expiry, now) : null;
    const left = collected == null ? paid : Math.max(0, paid - collected);
    const callNow = calls.reduce((a, l) => a + l.per_day, 0);
    const daysToEven = left <= 0 ? 0 : callNow > 0 ? Math.ceil(left / callNow) : null;
    // Nov 19 (Jake: "show days left of price floor insurance, and current call premium minus put premium"): the calendar days
    // the put floor has left, and the open call's premium against the puts' cost.
    const callPremiumNow = calls.reduce((a, l) => a + Number(l.premium) * Number(l.contracts) * 100, 0);
    return {
      symbol, from: basis, calendar_days_left: expiry ? Math.max(0, Math.ceil(daysTo(expiry, now))) : null,
      // Calls against puts is everything the calls have brought in (Nov 19: "total premium against total puts"); the open
      // call's own premium only when no call entries are known.
      call_premium_now: r2(callPremiumNow), calls_total: r2(collected ?? callPremiumNow), call_less_put: r2((collected ?? callPremiumNow) - paid), puts_paid: r2(paid), calls_collected: collected == null ? null : r2(collected), left: r2(left),
      puts_in_entries: c ? r2(entryPaid) : null, puts_held_cost: r2(heldCost), call_entries: c ? c.call_entries : 0, put_entries: c ? c.put_entries : 0,
      put_expiry: expiry, trading_days_left: daysLeft, needed_per_day: daysLeft ? r2(left / daysLeft) : null,
      call_now_per_day: r2(callNow), days_to_even: daysToEven, even_on: daysToEven ? sessionDate(daysToEven, now) : null,
      in_time: daysToEven == null || daysLeft == null ? null : daysToEven <= daysLeft,
    };
  }).filter(Boolean);
  const sum = (k) => r2(rows.reduce((a, r) => a + (r[k] || 0), 0));
  const left = sum('left'); const callNow = sum('call_now_per_day');
  const expiry = rows.map((r) => r.put_expiry).filter(Boolean).sort().at(-1) || null;
  const daysToEven = left <= 0 ? 0 : callNow > 0 ? Math.ceil(left / callNow) : null;
  return {
    stocks: rows,
    total: rows.length ? {
      puts_paid: sum('puts_paid'), calls_collected: sum('calls_collected'), left, put_expiry: expiry,
      from: rows.every((r) => r.from === 'entries') ? 'entries' : 'mixed', calls_unknown: rows.filter((r) => r.calls_collected == null).map((r) => r.symbol),
      puts_from_held: rows.filter((r) => r.from === 'held').map((r) => r.symbol),
      call_entries: rows.reduce((a, r) => a + r.call_entries, 0), put_entries: rows.reduce((a, r) => a + r.put_entries, 0),
      trading_days_left: expiry ? incomeDays(expiry, now) : null, needed_per_day: sum('needed_per_day'), call_now_per_day: callNow,
      calendar_days_left: expiry ? Math.max(0, Math.ceil(daysTo(expiry, now))) : null,
      call_premium_now: sum('call_premium_now'), calls_total: sum('calls_total'), call_less_put: sum('call_less_put'),
      days_to_even: daysToEven, even_on: daysToEven ? sessionDate(daysToEven, now) : null,
    } : null,
  };
}

/**
 * What his holdings earned each of the last sessions (Jake, Nov 18, for Andrew's stock panel: "mix in my previous days
 * earnings and show my current holdings"): for each completed US session, the shares' move (the shares he holds now, from
 * the day each position was opened, times the close's change on Cboe's daily history) and the option premium in his Money
 * Hub entries dated that day (calls in, puts out). US$, with the Bank of Canada rate for CAD.
 */
export async function sessionEarnings({ sessions = 5, now = new Date(), list: given = null, fx: givenFx, historyImpl = null } = {}) {
  const { positions } = await import('./desk.js');
  const { history } = await import('./market.js');
  const { usdCad } = await import('./fx.js');
  const { expiryClose, isTradingDay } = await import('./strategy.js');
  const [list, fx] = await Promise.all([given || positions(now), givenFx === undefined ? usdCad().catch(() => null) : givenFx]);
  const open = list.filter((p) => p.status === 'open' && Number(p.shares) > 0);
  const cash = await optionCash({ symbols: open.map((p) => p.symbol) });
  const toUsd = (n) => (cash.currency === 'CAD' && fx?.rate ? n / fx.rate : n);
  const done = (d) => isTradingDay(d) && now >= expiryClose(d);
  const moves = new Map(); // date -> symbol -> { close, change }
  for (const p of open) {
    let h = [];
    try { h = await (historyImpl || history)(p.symbol, sessions + 8); } catch { h = []; }
    h = h.filter((r) => r.date && Number.isFinite(r.close) && done(r.date));
    for (let i = 1; i < h.length; i++) {
      if (!moves.has(h[i].date)) moves.set(h[i].date, new Map());
      moves.get(h[i].date).set(p.symbol, { close: h[i].close, change: h[i].close - h[i - 1].close });
    }
  }
  const dates = [...moves.keys()].sort().slice(-sessions).reverse();
  const rows = dates.map((date) => {
    const by_stock = open.map((p) => {
      const m = moves.get(date).get(p.symbol);
      const held = !p.opened_on || p.opened_on <= date;
      const opt = cash.entries.filter((e) => e.date === date && e.symbol === p.symbol);
      const calls = toUsd(opt.filter((e) => e.kind === 'call').reduce((a, e) => a + e.amount, 0));
      const puts = toUsd(opt.filter((e) => e.kind === 'put').reduce((a, e) => a + e.amount, 0));
      const shares = m && held ? Number(p.shares) * m.change : 0;
      return { symbol: p.symbol, shares: Number(p.shares), close: m ? r2(m.close) : null, change: m ? r2(m.change) : null, held,
        shares_change: r2(shares), calls: r2(calls), puts: r2(puts), total: r2(shares + calls + puts) };
    });
    const sum = (k) => r2(by_stock.reduce((a, x) => a + x[k], 0));
    return { id: date, date, shares_change: sum('shares_change'), calls: sum('calls'), puts: sum('puts'), options: r2(sum('calls') + sum('puts')), total: sum('total'),
      by_stock, usd_cad: fx?.rate || null, note: 'US$; shares at what he holds now, from the day each position opened; options from his Money Hub entries dated that day' };
  });
  return rows;
}

/**
 * The options he holds, at what his fills say they cost (Jake, Nov 19: "NVDA put cost shows US$1,055, but you actually paid
 * US$966 net. It's using Wealthsimple's lumped cost basis"). The broker's average price lumps every trade in a contract
 * together; his Money Hub entries are the real cash. Pure, US$.
 *   A put he holds: what the puts on that stock have cost net (bought, less any sold back), over the puts held; from the
 *   first put entry.
 *   The call he has sold (one at a time): what the latest call sale brought, from the day it was sold, so its premium a day is
 *   that call's alone, not every call before it spread over this one's few days.
 * Legs the entries can't speak for keep the broker's figure (broker_premium is kept either way).
 */
export function legsAtFills(legs = [], entries = [], symbol, { today = null } = {}) {
  const mine = entries.filter((e) => e.symbol === symbol && (!today || e.date <= today));
  const putEntries = mine.filter((e) => e.kind === 'put');
  const callSales = mine.filter((e) => e.kind === 'call' && e.amount > 0).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  const longPuts = legs.filter((l) => l.type === 'put' && l.side === 'long');
  const shortCalls = legs.filter((l) => l.type === 'call' && l.side === 'short');
  const putNet = -putEntries.reduce((a, e) => a + e.usd, 0);
  const putContracts = longPuts.reduce((a, l) => a + Number(l.contracts), 0);
  const putFrom = putEntries.map((e) => e.date).sort()[0] || null;
  return legs.map((l) => {
    if (l.type === 'put' && l.side === 'long' && putNet > 0 && putContracts > 0) {
      return { ...l, broker_premium: Number(l.premium), premium: r2(putNet / (putContracts * 100) * 10000) / 10000, ...(putFrom ? { since: putFrom } : {}), from_fills: true };
    }
    if (l.type === 'call' && l.side === 'short' && shortCalls.length === 1 && callSales[0] && callSales[0].date <= l.expiry) {
      const sale = callSales[0];
      return { ...l, broker_premium: Number(l.premium), premium: Math.round((sale.usd / (Number(l.contracts) * 100)) * 10000) / 10000, since: sale.date, from_fills: true };
    }
    return l;
  });
}

/**
 * Call premium banked from calls already closed, rolled or expired (Jake, Nov 19: "These need to use total premium against
 * total puts"): every call entry on the stock (sales in, buybacks out, US$), less what the calls still open are counted at
 * (legsAtFills: the latest sale), so the open call isn't counted twice. since: the first call entry. Pure.
 */
export function bankedCalls(legs = [], entries = [], symbol, { today = null } = {}) {
  const calls = entries.filter((e) => e.symbol === symbol && e.kind === 'call' && (!today || e.date <= today));
  if (!calls.length) return null;
  const total = calls.reduce((a, e) => a + e.usd, 0);
  const open = legs.filter((l) => l.type === 'call' && l.side === 'short').reduce((a, l) => a + Number(l.premium) * Number(l.contracts) * 100, 0);
  return { usd: r2(total - open), total: r2(total), since: calls.map((e) => e.date).sort()[0] };
}
