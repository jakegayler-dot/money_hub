// Tax, GST, program and statement dates are tasks, here and in Sentinel (Jake, Oct 31).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { applyDone, setTaskDone, isTask } from '../lib/calendar.js';
import { deadlineSnapshotItems, taskSnapshotItem } from '../lib/sentinelSnapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let db;
before(async () => {
  db = new PGlite();
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  pool.query = (t, p) => db.query(t, p);
});
after(async () => { await db?.close(); });

const items = () => [
  { id: 'gst:2026-07-01', date: '2026-11-30', kind: 'gst', title: 'GST return — Q3 2026', amount: -1234.5, link: '/tax' },
  { id: 'deadline:agriinvest_deposit:2026-12-31', date: '2026-12-31', kind: 'program', title: 'AgriInvest deposit', amount: null },
  { id: 'gst:2026-04-01', date: '2026-07-31', kind: 'gst', title: 'GST return — Q2 2026 (filed)', done: true, amount: null },
  { id: 'rebate:1', date: '2027-02-15', kind: 'contract', title: 'Rebate expected', amount: 3400 },
  { id: 'heads:gst:2026-07-01', date: '2026-11-16', kind: 'gst', title: 'Coming up', heads_up: true, amount: null },
];

test('which are tasks; ticked off is done; reopened is open again; a filed return stays done', async () => {
  assert.deepEqual(items().filter(isTask).map((i) => i.id), ['gst:2026-07-01', 'deadline:agriinvest_deposit:2026-12-31', 'gst:2026-04-01']);
  await setTaskDone('deadline:agriinvest_deposit:2026-12-31', true);
  let list = await applyDone(items());
  assert.equal(list[1].done, true);
  assert.equal(list[1].task, true);
  assert.ok(!list[0].done);
  await setTaskDone('deadline:agriinvest_deposit:2026-12-31', false);
  list = await applyDone(items());
  assert.ok(!list[1].done);
  assert.equal(list[2].done, true);
});

test('to Sentinel: tasks with reminders, the amount in the title; heads-ups left to Sentinel; incoming money as events', async () => {
  const list = await applyDone(items());
  const out = deadlineSnapshotItems(list, { from: '2026-07-01', to: '2027-12-31', appUrl: 'https://mh.example', today: '2026-10-31' });
  const by = Object.fromEntries(out.map((x) => [x.source_id, x]));
  const gst = by['task:gst:2026-07-01'];
  assert.equal(gst.kind, 'task');
  assert.equal(gst.status, 'open');
  assert.equal(gst.title, 'GST return — Q3 2026 — pay $1,234.50');
  assert.deepEqual(gst.suggested_alerts, [{ offset_minutes: -14 * 1440 }, { offset_minutes: -1440 }, { offset_minutes: 0 }]);
  assert.equal(gst.amount_cents, undefined);
  assert.equal(by['task:gst:2026-04-01'].status, 'done');
  assert.equal(by['rebate:1'].kind, 'event');
  assert.ok(!out.some((x) => /heads/.test(x.source_id)));
  assert.equal(taskSnapshotItem({ id: 'tax:file:2026', kind: 'tax', title: 'File', date: '2027-06-15' }, {}).suggested_alerts[0].offset_minutes, -30 * 1440);
});
