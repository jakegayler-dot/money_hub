// Reads what Quicken exports — QIF (Quicken Classic, Windows and Mac) and
// CSV (Classic reports, Quicken for Mac, Quicken Simplifi) — into one shape:
//
//   { format, date_order, accounts: [{ name, qtype, lines: [line] }], warnings }
//   line = { date: 'YYYY-MM-DD', amount, payee, memo, category, cls, num,
//            status: 'cleared'|'reconciled'|'uncleared'|'pending',
//            splits: [{ category, cls, amount, memo }] }
//
// Amounts are signed from the account's side, as Quicken shows them:
// money out (a purchase, a cheque, a card charge) negative, money in
// positive. A category in square brackets — [Farm Operating] — is a
// transfer to that Quicken account.
//
// Dates: Quicken writes them the way the computer's region is set, so
// 03/04/2026 can be March 4 or April 3. The order is worked out from the
// file (a day over 12 settles it); when nothing settles it, `fallback`
// (the order used last time) decides, else month first, Quicken's default.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const validYmd = (y, m, d) => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1980 && y <= 2100)) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return t.getUTCDate() === d ? iso : null;
};
const fullYear = (y) => {
  const n = Number(y);
  if (String(y).length >= 3) return n;
  return n < 70 ? 2000 + n : 1900 + n;
};

/** Pieces of a date string: { iso } when unambiguous by its form, else { a, b, y } for a slash date. */
function datePieces(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '');
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return { iso: validYmd(Number(m[1]), Number(m[2]), Number(m[3])) };
  m = /^(\d{1,2})[/.\-](\d{1,2})(?:'|[/.\-])(\d{2,4})$/.exec(s); // 10/13'26, 10/13/2026, 13.10.26
  if (m) return { a: Number(m[1]), b: Number(m[2]), y: fullYear(m[3]) };
  m = /^([A-Za-z]{3,9})\.?(\d{1,2}),?(\d{4})$/.exec(s); // Oct13,2026
  if (m) {
    const name = m[1].toLowerCase();
    const mo = MONTHS[name.slice(0, 4)] ?? MONTHS[name.slice(0, 3)];
    if (mo) return { iso: validYmd(Number(m[3]), mo, Number(m[2])) };
  }
  m = /^(\d{1,2})-?([A-Za-z]{3})-?(\d{2,4})$/.exec(s); // 13-Oct-2026
  if (m && MONTHS[m[2].toLowerCase()]) return { iso: validYmd(fullYear(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])) };
  return null;
}

/** Decides month-first or day-first from every slash date in the file. */
export function dateOrder(raws, fallback = null) {
  let mdy = false;
  let dmy = false;
  let slashDates = 0;
  for (const r of raws) {
    const p = datePieces(r);
    if (!p || p.iso !== undefined) continue;
    slashDates += 1;
    if (p.a > 12) dmy = true;
    if (p.b > 12) mdy = true;
  }
  if (mdy && dmy) return { order: null, error: 'Dates in this file are written both ways (month first and day first) — export it again.' };
  if (mdy) return { order: 'mdy', decided: true, evidence: true };
  if (dmy) return { order: 'dmy', decided: true, evidence: true };
  // Nothing to decide when every date is written out (2026-10-13, Oct 13 2026).
  return { order: fallback || 'mdy', decided: slashDates === 0 || !!fallback };
}

export function parseDate(raw, order = 'mdy') {
  const p = datePieces(raw);
  if (!p) return null;
  if (p.iso !== undefined) return p.iso;
  return order === 'dmy' ? validYmd(p.y, p.b, p.a) : validYmd(p.y, p.a, p.b);
}

/** "$1,234.56", "(1,234.56)", "-1234.56", "1234.56-", "1 234.56" → number, else null. */
export function parseAmount(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
  s = s.replace(/[$\s,]|CAD|USD/gi, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** "Fuel:Diesel/Grain" → { category: 'Fuel:Diesel', cls: 'Grain' }; "[Farm Operating]" → { transfer: 'Farm Operating' }. */
export function splitCategory(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '--Split--' || /^split$/i.test(s)) return { category: null, cls: null, transfer: null, split: !!s };
  const [catPart, ...clsParts] = s.split('/');
  const cls = clsParts.join('/').trim() || null;
  const c = catPart.trim();
  let m = /^\[(.+)\]$/.exec(c);
  if (m) return { category: null, cls, transfer: m[1].trim() };
  m = /^transfers?\s*(?::|to|from|-)?\s*\[?([^\]]+?)\]?$/i.exec(c);
  if (m && !/^transfers?$/i.test(c)) return { category: null, cls, transfer: m[1].trim() };
  if (/^transfers?$/i.test(c)) return { category: null, cls, transfer: '' }; // a transfer, other side not named
  return { category: c || null, cls, transfer: null };
}

// ---- QIF ------------------------------------------------------------------------

export function parseQif(text, { account = null, fallbackOrder = null } = {}) {
  const warnings = [];
  const rows = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const accounts = new Map();
  const get = (name, qtype) => {
    if (!accounts.has(name)) accounts.set(name, { name, qtype: qtype || null, raw: [] });
    const a = accounts.get(name);
    if (qtype && !a.qtype) a.qtype = qtype;
    return a;
  };
  let section = null; // 'account' | 'txn' | 'skip'
  let autoswitch = false;
  let current = account ? { name: account, qtype: null } : null;
  let rec = {};
  let txType = null;
  let skippedInvest = 0;
  const flush = () => {
    if (!Object.keys(rec).length) return;
    if (section === 'account') {
      if (rec.N) {
        if (!autoswitch) current = { name: rec.N, qtype: rec.T || null };
        get(rec.N, rec.T || null);
      }
    } else if (section === 'txn') {
      if (!current) current = { name: 'Quicken export', qtype: txType };
      get(current.name, current.qtype || txType).raw.push(rec);
    }
    rec = {};
  };
  for (const raw of rows) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (line.startsWith('!')) {
      flush();
      const h = line.toLowerCase();
      if (h === '!option:autoswitch') { autoswitch = true; section = 'account'; continue; }
      if (h === '!clear:autoswitch') { autoswitch = false; continue; }
      if (h === '!account') { section = 'account'; continue; }
      const m = /^!type:(.+)$/i.exec(line);
      if (m) {
        const t = m[1].trim().toLowerCase();
        if (['bank', 'cash', 'ccard', 'oth a', 'oth l'].includes(t)) {
          section = 'txn'; txType = m[1].trim();
          if (current && !current.qtype) current.qtype = txType;
        } else {
          if (t.startsWith('invst')) skippedInvest += 1;
          section = 'skip';
        }
        continue;
      }
      section = 'skip';
      continue;
    }
    if (line === '^') { flush(); continue; }
    if (section === 'skip' || !section) continue;
    const code = line[0];
    const val = line.slice(1);
    if (section === 'account') { rec[code] = val.trim(); continue; }
    // Transaction fields; split lines repeat S / $ / E in order.
    if (code === 'S') { (rec.splits ||= []).push({ S: val.trim() }); continue; }
    if (code === 'E') { const s = rec.splits?.[rec.splits.length - 1]; if (s) s.E = val.trim(); continue; }
    if (code === '$') { const s = rec.splits?.[rec.splits.length - 1]; if (s) s.$ = val.trim(); continue; }
    if (code === 'A') { (rec.A ||= []).push(val.trim()); continue; }
    if (rec[code] === undefined) rec[code] = val.trim();
  }
  flush();
  if (skippedInvest) warnings.push('Investment accounts in the file were skipped.');

  const allDates = [...accounts.values()].flatMap((a) => a.raw.map((r) => r.D));
  const ord = dateOrder(allDates, fallbackOrder);
  if (ord.error) return { format: 'qif', error: ord.error, accounts: [], warnings };
  if (!ord.decided && allDates.length) warnings.push(`Dates could be month-first or day-first; read as ${ord.order === 'mdy' ? 'month/day' : 'day/month'}.`);

  const out = [];
  for (const a of accounts.values()) {
    const lines = [];
    for (const r of a.raw) {
      const date = parseDate(r.D, ord.order);
      const amount = parseAmount(r.T ?? r.U);
      if (!date || amount == null) { if (r.D || r.T) warnings.push(`Skipped a line in ${a.name} it couldn't read (date "${r.D || ''}", amount "${r.T ?? r.U ?? ''}").`); continue; }
      const c = splitCategory(r.L);
      const status = r.C === '*' ? 'cleared' : /^[xr]$/i.test(r.C || '') ? 'reconciled' : 'uncleared';
      const splits = (r.splits || []).map((s) => ({ ...splitCategory(s.S), amount: parseAmount(s.$), memo: s.E || null }))
        .filter((s) => s.amount != null && s.amount !== 0);
      lines.push({ date, amount, payee: r.P || null, memo: r.M || null, category: c.category, cls: c.cls, transfer: c.transfer,
        num: r.N || null, status, splits: splits.length > 1 ? splits : [] });
    }
    out.push({ name: a.name, qtype: a.qtype, lines }); // empty ones too: their type tells transfers to a loan apart
  }
  return { format: 'qif', date_order: ord.order, date_evidence: !!ord.evidence, accounts: out, warnings };
}

// ---- CSV ------------------------------------------------------------------------

/** RFC-4180-ish: quoted fields, doubled quotes, commas or tabs or semicolons. */
export function csvRows(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLines = src.split(/\r?\n/).slice(0, 20).join('\n');
  const delim = (firstLines.match(/\t/g) || []).length > (firstLines.match(/,/g) || []).length ? '\t'
    : (firstLines.match(/;/g) || []).length > (firstLines.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

const ALIASES = {
  date: ['date', 'posted on', 'postedon', 'posted date', 'transaction date', 'txn date'],
  amount: ['amount', 'amt', 'transaction amount'],
  inflow: ['deposit', 'deposits', 'inflow', 'credit', 'credits', 'money in', 'income'],
  outflow: ['withdrawal', 'withdrawals', 'payment', 'payments', 'outflow', 'debit', 'debits', 'money out', 'expense', 'charge'],
  payee: ['payee', 'description', 'merchant', 'name', 'payee name'],
  memo: ['memo', 'notes', 'note', 'memo/notes'],
  category: ['category', 'category name'],
  account: ['account', 'account name', 'accountname'],
  num: ['num', 'check', 'check #', 'check number', 'cheque', 'cheque #', 'ref', 'reference'],
  status: ['clr', 'cleared', 'status', 'state', 'cleared status'],
  tag: ['tag', 'tags', 'class'],
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9#/ ]+/g, ' ').replace(/\s+/g, ' ').trim();

function headerMap(row) {
  const cols = {};
  row.forEach((h, i) => {
    const n = norm(h);
    for (const [k, names] of Object.entries(ALIASES)) if (cols[k] === undefined && names.includes(n)) cols[k] = i;
  });
  return cols;
}

export function parseCsv(text, { account = null, fallbackOrder = null } = {}) {
  const warnings = [];
  const rows = csvRows(text).filter((r) => r.some((c) => c !== ''));
  // The header is the first row naming a date and an amount (reports put a title above it).
  let hi = -1;
  let cols = null;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const c = headerMap(rows[i]);
    if (c.date !== undefined && (c.amount !== undefined || c.inflow !== undefined || c.outflow !== undefined)) { hi = i; cols = c; break; }
  }
  if (hi < 0) return { format: 'csv', error: 'No header row with a date and an amount column was found. Export the register or a transaction report as CSV.', accounts: [], warnings };
  if (cols.account === undefined && !account) {
    return { format: 'csv', error: 'This CSV has no Account column — say which Quicken account it is (account).', accounts: [], warnings };
  }
  const body = rows.slice(hi + 1);
  const ord = dateOrder(body.map((r) => r[cols.date]), fallbackOrder);
  if (ord.error) return { format: 'csv', error: ord.error, accounts: [], warnings };
  if (!ord.decided && body.length) warnings.push(`Dates could be month-first or day-first; read as ${ord.order === 'mdy' ? 'month/day' : 'day/month'}.`);

  const byAccount = new Map();
  let lastAccount = account;
  let skipped = 0;
  let pending = 0;
  for (const r of body) {
    const cell = (k) => (cols[k] === undefined ? '' : (r[cols[k]] ?? ''));
    // Classic reports print the account once above its rows.
    if (cols.account !== undefined && cell('account')) lastAccount = cell('account');
    const date = parseDate(cell('date'), ord.order);
    let amount = cols.amount !== undefined ? parseAmount(cell('amount')) : null;
    if (amount == null && (cols.inflow !== undefined || cols.outflow !== undefined)) {
      const inn = parseAmount(cell('inflow')) || 0;
      const out = parseAmount(cell('outflow')) || 0;
      amount = (inn || out) ? inn - Math.abs(out) : null;
    }
    if (!date || amount == null || amount === 0) { if (cell('date') && !/total|balance/i.test(r.join(' '))) skipped += 1; continue; }
    const st = norm(cell('status'));
    if (/pending/.test(st)) { pending += 1; continue; }
    const status = st === 'r' || /reconcil/.test(st) ? 'reconciled' : st === 'c' || st === '*' || /clear|posted/.test(st) ? 'cleared' : 'uncleared';
    const c = splitCategory(cell('category'));
    const name = lastAccount || account;
    if (!byAccount.has(name)) byAccount.set(name, { name, qtype: null, lines: [] });
    byAccount.get(name).lines.push({
      date, amount, payee: cell('payee') || null, memo: cell('memo') || null, category: c.category, cls: c.cls || cell('tag') || null,
      transfer: c.transfer, num: cell('num') || null, status, splits: [], split_unknown: !!c.split,
    });
  }
  if (skipped) warnings.push(`${skipped} row${skipped === 1 ? '' : 's'} couldn't be read (no date or amount) and were skipped.`);
  if (pending) warnings.push(`${pending} pending transaction${pending === 1 ? '' : 's'} left out until ${pending === 1 ? 'it posts' : 'they post'}.`);
  return { format: 'csv', date_order: ord.order, date_evidence: !!ord.evidence, accounts: [...byAccount.values()], warnings };
}

/** Lines an agent read off Quicken and sent as JSON. */
export function parseJsonLines(lines, { fallbackOrder = null } = {}) {
  const warnings = [];
  const ord = dateOrder(lines.map((l) => l.date), fallbackOrder);
  const byAccount = new Map();
  for (const [i, l] of lines.entries()) {
    const date = parseDate(l.date, ord.order || 'mdy');
    const amount = typeof l.amount === 'number' ? l.amount : parseAmount(l.amount);
    if (!l.account || !date || amount == null || amount === 0) { warnings.push(`Line ${i + 1} needs account, date and a non-zero amount.`); continue; }
    const c = l.transfer_account ? { category: null, cls: null, transfer: l.transfer_account } : splitCategory(l.category);
    if (!byAccount.has(l.account)) byAccount.set(l.account, { name: l.account, qtype: l.account_type || null, lines: [] });
    byAccount.get(l.account).lines.push({
      date, amount, payee: l.payee || null, memo: l.memo || null, category: c.category, cls: c.cls, transfer: c.transfer, num: l.num || null,
      status: l.status || 'cleared',
      splits: Array.isArray(l.splits) ? l.splits.map((s) => ({ ...splitCategory(s.category), amount: Number(s.amount), memo: s.memo || null })) : [],
    });
  }
  return { format: 'json', date_order: ord.order, date_evidence: !!ord.evidence, accounts: [...byAccount.values()], warnings };
}

/** Picks the parser from the content. */
export function parseQuicken(content, opts = {}) {
  if (Array.isArray(content)) return parseJsonLines(content, opts);
  const text = String(content || '');
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 400);
  if (/^!(type|account|option|clear)/im.test(head)) return parseQif(text, opts);
  return parseCsv(text, opts);
}
