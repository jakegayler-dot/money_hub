// Earnings for the covered-call desk (Jake, Nov 19: "factor in earnings for the stocks in the list ... ie. earnings report
// calendar"): Nasdaq's calendar, a weekday at a time; a report before the call expires keeps a stock out of the day's five.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db.js';
import { parseDay, inside, refresh, nextEarnings, _state } from '../lib/options/earnings.js';

pool.query = async () => ({ rows: [] }); // no database: nothing kept between runs

test('a day of Nasdaq’s calendar: symbol and when', () => {
  const body = { data: { rows: [{ symbol: 'NVDA', time: 'time-after-hours' }, { symbol: 'wmt', time: 'time-pre-market' }, { symbol: 'XYZ', time: 'time-not-supplied' }, {}] } };
  assert.deepEqual(parseDay(body), [['NVDA', 'after the close'], ['WMT', 'before the open'], ['XYZ', 'time not given']]);
  assert.deepEqual(parseDay({ data: { rows: null } }), []);
});

test('inside an option’s life: before its expiry, or on it before the close', () => {
  assert.equal(inside({ date: '2026-11-19', time: 'after the close' }, '2026-11-20'), true);
  assert.equal(inside({ date: '2026-11-20', time: 'before the open' }, '2026-11-20'), true);
  assert.equal(inside({ date: '2026-11-20', time: 'time not given' }, '2026-11-20'), true, 'unknown time: counted, to be safe');
  assert.equal(inside({ date: '2026-11-20', time: 'after the close' }, '2026-11-20'), false, 'after the call has expired');
  assert.equal(inside({ date: '2026-12-01', time: 'before the open' }, '2026-11-20'), false);
  assert.equal(inside(null, '2026-11-20'), false);
});

test('the calendar is read a weekday at a time; each stock’s next report; a refusal is said, not hidden', async () => {
  const now = new Date('2026-11-19T15:00:00Z'); // Thursday
  const asked = [];
  const fetchImpl = async (url) => {
    const d = new URL(url).searchParams.get('date'); asked.push(d);
    if (d === '2026-11-23') return new Response('{}', { status: 403 });
    const rows = { '2026-11-20': [{ symbol: 'AMD', time: 'time-pre-market' }], '2026-12-02': [{ symbol: 'AMD', time: 'time-after-hours' }, { symbol: 'CRM', time: 'time-after-hours' }] }[d] || [];
    return Response.json({ data: { rows } });
  };
  await refresh({ fetchImpl, now, pause: 0 });
  assert.ok(!asked.includes('2026-11-21') && !asked.includes('2026-11-22'), 'no weekends');
  assert.equal(asked[0], '2026-11-19');
  assert.match(_state.error, /1 day of the earnings calendar couldn't be read \(Nasdaq said 403\)/);
  const { map } = await nextEarnings({ now, fetchImpl });
  assert.deepEqual(map.get('AMD'), { date: '2026-11-20', time: 'before the open' }, 'the next one, not a later one');
  assert.deepEqual(map.get('CRM'), { date: '2026-12-02', time: 'after the close' });
  assert.equal(map.get('NVDA'), undefined);
  // A day missing near the front starts a retry behind the read (as here); once that is done, a read within the day asks only for
  // the day that failed.
  if (_state.running) await _state.running;
  asked.length = 0;
  await refresh({ fetchImpl, now: new Date('2026-11-19T18:00:00Z'), pause: 0 });
  assert.deepEqual(asked, ['2026-11-23']);
});
