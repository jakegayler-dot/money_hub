import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQif, parseCsv, parseQuicken, parseDate, parseAmount, dateOrder, splitCategory } from '../lib/quickenParse.js';

const QIF = `!Option:AutoSwitch
!Account
NFarm Operating
TBank
^
NFarm Visa 4417
TCCard
^
!Clear:AutoSwitch
!Account
NFarm Operating
TBank
^
!Type:Bank
D10/ 5'26
T-412.60
C*
PSaskPower
LUtilities:Power/Grain
^
D10/14'26
U-1,250.00
PFCC
L[Land Loan]
^
D10/15'26
T-300.00
PCo-op
LFuel
SFuel:Diesel
$-200.00
EDiesel
SRepairs
$-100.00
^
D10/16'26
T-900.00
PVisa payment
L[Farm Visa 4417]
^
!Account
NFarm Visa 4417
TCCard
^
!Type:CCard
D10/16'26
T900.00
PPayment
L[Farm Operating]
^
D10/2'26
T-87.11
PUFA
LFuel
^
`;

test('QIF: accounts, dates, amounts, categories, transfers, splits', () => {
  const r = parseQif(QIF);
  assert.equal(r.format, 'qif');
  assert.deepEqual(r.accounts.map((a) => [a.name, a.qtype, a.lines.length]), [['Farm Operating', 'Bank', 4], ['Farm Visa 4417', 'CCard', 2]]);
  const [power, loan, split, pay] = r.accounts[0].lines;
  assert.deepEqual([power.date, power.amount, power.category, power.cls, power.status], ['2026-10-05', -412.6, 'Utilities:Power', 'Grain', 'cleared']);
  assert.equal(loan.transfer, 'Land Loan');
  assert.equal(loan.amount, -1250);
  assert.deepEqual(split.splits.map((s) => [s.category, s.amount, s.memo]), [['Fuel:Diesel', -200, 'Diesel'], ['Repairs', -100, null]]);
  assert.equal(pay.transfer, 'Farm Visa 4417');
  assert.equal(r.accounts[1].lines[0].transfer, 'Farm Operating');
  assert.equal(r.date_order, 'mdy');
});

test('dates: worked out from the file, day-first when a day is over 12', () => {
  assert.equal(dateOrder(['03/04/2026', '25/04/2026']).order, 'dmy');
  assert.equal(dateOrder(['03/04/2026', '04/25/2026']).order, 'mdy');
  assert.equal(dateOrder(['03/04/2026'], 'dmy').order, 'dmy');
  assert.equal(dateOrder(['03/04/2026']).decided, false);
  assert.equal(dateOrder(['2026-03-04']).decided, true);
  assert.ok(dateOrder(['13/04/2026', '04/25/2026']).error);
  assert.equal(parseDate('2026-10-13'), '2026-10-13');
  assert.equal(parseDate("1/ 5'26"), '2026-01-05');
  assert.equal(parseDate('05/01/2026', 'dmy'), '2026-01-05');
  assert.equal(parseDate('Oct 13, 2026'), '2026-10-13');
  assert.equal(parseDate('02/30/2026'), null);
});

test('amounts and categories', () => {
  assert.equal(parseAmount('$1,234.56'), 1234.56);
  assert.equal(parseAmount('(1,234.56)'), -1234.56);
  assert.equal(parseAmount('-87.11'), -87.11);
  assert.equal(parseAmount('87.11-'), -87.11);
  assert.equal(parseAmount('abc'), null);
  assert.deepEqual(splitCategory('Transfer to [Savings]'), { category: null, cls: null, transfer: 'Savings' });
  assert.equal(splitCategory('Transfer').transfer, '');
  assert.equal(splitCategory('--Split--').split, true);
});

test('CSV: a Classic report with a title, totals and the account above its rows', () => {
  const csv = `"Transaction Report"
"10/1/2026 through 10/13/2026"

,"Date","Account","Num","Description","Memo","Category","Clr","Amount"
,"10/02/2026","Farm Operating","","Viterra","Canola","Grain Sales:Canola","R","29,700.00"
,"10/05/2026","","1043","Smith","","Pasture Rent","","-4,200.00"
,"","","","","","","","Total","25,500.00"
`;
  const r = parseCsv(csv);
  assert.equal(r.accounts.length, 1);
  assert.equal(r.accounts[0].name, 'Farm Operating');
  assert.deepEqual(r.accounts[0].lines.map((l) => [l.date, l.amount, l.payee, l.category, l.status, l.num]),
    [['2026-10-02', 29700, 'Viterra', 'Grain Sales:Canola', 'reconciled', null], ['2026-10-05', -4200, 'Smith', 'Pasture Rent', 'uncleared', '1043']]);
});

test('CSV: Simplifi-style, pending left out; no account column needs one named', () => {
  const csv = `account,postedOn,payee,category,amount,tags,notes,state
Farm Visa,2026-10-10,UFA,Fuel,-87.11,,,CLEARED
Farm Visa,2026-10-12,Peavey Mart,Supplies,-45.00,,,PENDING
`;
  const r = parseQuicken(csv);
  assert.equal(r.format, 'csv');
  assert.equal(r.accounts[0].lines.length, 1);
  assert.match(r.warnings.join(' '), /pending/);
  const noAccount = parseCsv('Date,Payee,Amount\n2026-10-10,UFA,-87.11\n');
  assert.ok(noAccount.error);
  assert.equal(parseCsv('Date,Payee,Amount\n2026-10-10,UFA,-87.11\n', { account: 'Farm Visa' }).accounts[0].lines.length, 1);
});
