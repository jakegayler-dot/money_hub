import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { allocateBySegment, ownerWeights, OWNERS } from '../lib/segments.js';

const router = Router();

const CLASSES = ['fixed', 'variable_seasonal', 'capex', 'overhead'];

// Parents first, each followed by its subcategories. `full_name` ("Fuel &
// oil › Gasoline") is what pickers show, so a subcategory is never
// ambiguous about where it rolls up.
router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, p.name AS parent_name,
            CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' › ' || c.name END AS full_name
     FROM expense_categories c LEFT JOIN expense_categories p ON p.id = c.parent_id
     ORDER BY c.kind DESC, lower(COALESCE(p.name, c.name)), c.parent_id IS NOT NULL, lower(c.name)`
  );
  res.json(rows);
}));

// Actual spending this year by category, rolled up to parents. Reads the
// same split-aware lines as every other report: a split piece counts under
// its own category and owner. Excluded: transfers (moving money isn't
// spending it), loan payments (debt, not operating cost) and capital
// purchases (reported separately as capex_total). A refund tagged with a
// category nets against it. `owner` narrows to one owner's share.
router.get('/by-category', ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const owner = String(req.query.owner || 'all');
  if (owner !== 'all' && !OWNERS.includes(owner)) return res.status(400).json({ error: `owner must be all, ${OWNERS.join(', ')}` });
  const kind = req.query.kind === 'income' ? 'income' : 'expense';
  const weight = (row) => (owner === 'all' ? 1 : ownerWeights(row)[owner]);

  const [{ rows: cats }, { rows: lines }] = await Promise.all([
    pool.query('SELECT id, name, parent_id, kind FROM expense_categories'),
    pool.query(
      `SELECT amount, category_id, is_capex, segment, is_segment_split,
              segment_grain_pct, segment_livestock_pct, segment_jake_pct, segment_ashley_pct
       FROM transaction_lines
       WHERE is_transfer = false AND is_debt_service = false AND EXTRACT(YEAR FROM date) = $1`,
      [year]
    ),
  ]);
  const byId = new Map(cats.map((c) => [c.id, c]));
  // Expense view: spending (and refunds tagged to an expense category).
  // Income view: money in, by income category; positive amounts.
  const belongs = (l) => {
    const c = l.category_id ? byId.get(l.category_id) : null;
    if (c) return c.kind === kind;
    return kind === 'income' ? Number(l.amount) > 0 : Number(l.amount) < 0;
  };
  const spent = new Map(); // category id -> spend
  let uncategorized = 0;
  let capex = 0;
  for (const l of lines) {
    if (!belongs(l)) continue;
    const w = weight(l);
    if (!w) continue;
    // Spending is positive (a refund negative); income is positive.
    const amt = (kind === 'income' ? 1 : -1) * Number(l.amount) * w;
    if (l.is_capex) { capex += amt; continue; }
    if (!l.category_id || !byId.has(l.category_id)) { uncategorized += amt; continue; }
    spent.set(l.category_id, (spent.get(l.category_id) || 0) + amt);
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  const parents = new Map();
  const parentOf = (c) => (c.parent_id && byId.has(c.parent_id) ? byId.get(c.parent_id) : c);
  for (const [id, amt] of spent) {
    const c = byId.get(id);
    const p = parentOf(c);
    if (!parents.has(p.id)) parents.set(p.id, { id: p.id, name: p.name, total: 0, direct: 0, children: [] });
    const entry = parents.get(p.id);
    entry.total += amt;
    if (p.id === c.id) entry.direct += amt;
    else entry.children.push({ id: c.id, name: c.name, total: amt });
  }
  const out = [...parents.values()]
    .map((p) => ({
      ...p, total: r2(p.total), direct: r2(p.direct),
      children: p.children.map((ch) => ({ ...ch, total: r2(ch.total) })).sort((a, b) => b.total - a.total),
    }))
    .filter((p) => Math.abs(p.total) >= 0.005)
    .sort((a, b) => b.total - a.total);
  const total = out.reduce((s, p) => s + p.total, 0) + uncategorized;
  res.json({ year, owner, kind, total: r2(total), uncategorized: r2(uncategorized), capex_total: r2(capex), categories: out });
}));

// Actual money spent this year, split across owners — each split piece
// counted under its own owner, card purchases included, transfers
// excluded (moving money isn't spending it). Distinct from the budgeted
// distinct from the budgeted `expense_categories` totals above. Reads
// every outflow transaction (bills paid + manual entries alike, since both
// land in `transactions`) and allocates it by segment, splitting a
// percentage-split transaction proportionally rather than double-counting
// it in every bucket.
router.get('/segment-totals', ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT amount, segment, is_segment_split, segment_grain_pct, segment_livestock_pct,
            segment_jake_pct, segment_ashley_pct
     FROM transaction_lines
     WHERE amount < 0 AND is_transfer = false AND EXTRACT(YEAR FROM date) = $1`,
    [year]
  );

  const totals = { grain: 0, livestock: 0, jake: 0, ashley: 0, unassigned: 0 };
  for (const row of rows) {
    const allocated = allocateBySegment(row.amount, row);
    for (const k of Object.keys(totals)) totals[k] += allocated[k] || 0;
  }
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] * 100) / 100;

  res.json({ year, totals });
}));

const EVEN_MONTHLY_PCT = [0.0833,0.0833,0.0834,0.0833,0.0833,0.0834,0.0833,0.0833,0.0834,0.0833,0.0833,0.0834];

async function checkCategory(body, selfId = null) {
  const name = body.name != null ? String(body.name).trim() : null;
  if (name !== null) {
    if (!name) return { status: 400, error: 'name is required' };
    const { rows } = await pool.query(
      'SELECT id FROM expense_categories WHERE lower(name) = lower($1) AND ($2::int IS NULL OR id <> $2)', [name, selfId]
    );
    // Names are unique so an agent's "category": "Diesel — dyed" always
    // resolves to exactly one category.
    if (rows.length) return { status: 409, error: `A category named "${name}" already exists.` };
  }
  let parent = null;
  if (body.parent_id) {
    const { rows } = await pool.query('SELECT * FROM expense_categories WHERE id = $1', [body.parent_id]);
    parent = rows[0];
    if (!parent) return { status: 400, error: 'parent category not found' };
    if (parent.parent_id) return { status: 400, error: `"${parent.name}" is itself a subcategory — only two levels are allowed.` };
    if (selfId && Number(body.parent_id) === Number(selfId)) return { status: 400, error: 'A category can’t be its own parent.' };
    if (selfId) {
      const { rows: kids } = await pool.query('SELECT 1 FROM expense_categories WHERE parent_id = $1 LIMIT 1', [selfId]);
      if (kids.length) return { status: 400, error: 'This category has subcategories of its own, so it can’t become one.' };
    }
  }
  if (body.class && !CLASSES.includes(body.class)) return { status: 400, error: `class must be one of ${CLASSES.join(', ')}` };
  return { parent, name };
}

// A subcategory inherits its parent's class and ledger unless told otherwise.
router.post('/', ah(async (req, res) => {
  const chk = await checkCategory(req.body);
  if (chk.error) return res.status(chk.status).json({ error: chk.error });
  const { parent } = chk;
  const {
    class: klass = parent ? parent.class : 'variable_seasonal',
    ledger = parent ? parent.ledger : 'business',
    annual_total = 0, monthly_pct = EVEN_MONTHLY_PCT,
  } = req.body;
  // A subcategory is always the same kind as its parent.
  const kind = parent ? parent.kind : (req.body.kind === 'income' ? 'income' : 'expense');
  const { rows } = await pool.query(
    `INSERT INTO expense_categories (name, class, ledger, annual_total, monthly_pct, parent_id, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [chk.name, klass, ledger, Number(annual_total) || 0, JSON.stringify(monthly_pct), parent ? parent.id : null, kind]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', ah(async (req, res) => {
  const { rows: cur } = await pool.query('SELECT * FROM expense_categories WHERE id = $1', [req.params.id]);
  if (!cur.length) return res.status(404).json({ error: 'not found' });
  const chk = await checkCategory(req.body, Number(req.params.id));
  if (chk.error) return res.status(chk.status).json({ error: chk.error });
  const { annual_total, monthly_pct, class: klass, ledger } = req.body;
  const parentChange = req.body.parent_id !== undefined;
  const newKind = chk.parent ? chk.parent.kind : (['income', 'expense'].includes(req.body.kind) ? req.body.kind : null);
  const { rows } = await pool.query(
    `UPDATE expense_categories
     SET name = COALESCE($1, name),
         annual_total = COALESCE($2, annual_total),
         monthly_pct = COALESCE($3, monthly_pct),
         class = COALESCE($4, class),
         ledger = COALESCE($5, ledger),
         parent_id = CASE WHEN $6::boolean THEN $7::int ELSE parent_id END,
         kind = COALESCE($9, kind)
     WHERE id = $8 RETURNING *`,
    [chk.name, annual_total ?? null, monthly_pct ? JSON.stringify(monthly_pct) : null, klass || null, ledger || null,
     parentChange, req.body.parent_id || null, req.params.id, newKind]
  );
  // A main category's subcategories follow it if its kind changes.
  if (newKind && !rows[0].parent_id) await pool.query('UPDATE expense_categories SET kind = $1 WHERE parent_id = $2', [newKind, rows[0].id]);
  res.json(rows[0]);
}));

// Deleting a category that transactions use would silently uncategorize
// them, so it's refused — move them first (or rename instead). Its
// subcategories become parents of their own.
router.delete('/:id', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM transactions WHERE category_id = $1)
          + (SELECT COUNT(*) FROM transaction_splits WHERE category_id = $1) AS n`,
    [req.params.id]
  );
  const n = Number(rows[0].n);
  if (n > 0) return res.status(409).json({ error: `${n} transaction${n === 1 ? ' uses' : 's use'} this category. Rename it instead, or recategorize them first.` });
  const { rowCount } = await pool.query('DELETE FROM expense_categories WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

// A starting set that follows the CRA farm expense lines (T2042), with
// subcategories only where the detail changes decisions. Adds what's
// missing by name; never touches or duplicates existing categories.
const STANDARD = [
  ['Fertilizer & lime', 'variable_seasonal'],
  ['Chemicals', 'variable_seasonal'],
  ['Seed', 'variable_seasonal'],
  ['Feed & bedding', 'variable_seasonal', ['Hay & straw purchased', 'Grain purchased', 'Supplements & mineral']],
  ['Livestock purchased', 'variable_seasonal'],
  ['Veterinary & breeding', 'variable_seasonal'],
  ['Fuel & oil', 'variable_seasonal', ['Diesel — dyed', 'Diesel — clear', 'Gasoline', 'Oil & lubricants']],
  ['Machinery repairs & licences', 'variable_seasonal'],
  ['Building & fence repairs', 'variable_seasonal'],
  ['Custom work & rentals', 'variable_seasonal'],
  ['Twine, net wrap & containers', 'variable_seasonal'],
  ['Small tools', 'variable_seasonal'],
  ['Motor vehicle', 'variable_seasonal'],
  ['Wages & benefits', 'fixed'],
  ['Insurance', 'fixed', ['Crop insurance & AgriStability', 'Other insurance']],
  ['Utilities', 'fixed', ['Electricity', 'Heating fuel']],
  ['Rent & property taxes', 'fixed', ['Land rent', 'Property taxes']],
  ['Interest & bank charges', 'overhead'],
  ['Office, legal & accounting', 'overhead'],
  ['Other farm expenses', 'overhead'],
];

router.post('/standard-farm', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT id, lower(name) AS key FROM expense_categories');
  const existing = new Map(rows.map((r) => [r.key, r.id]));
  const added = [];
  for (const [name, klass, subs = []] of STANDARD) {
    let parentId = existing.get(name.toLowerCase());
    if (!parentId) {
      const { rows: ins } = await pool.query(
        `INSERT INTO expense_categories (name, class, ledger, monthly_pct) VALUES ($1, $2, 'business', $3) RETURNING id`,
        [name, klass, JSON.stringify(EVEN_MONTHLY_PCT)]
      );
      parentId = ins[0].id;
      existing.set(name.toLowerCase(), parentId);
      added.push(name);
    }
    for (const sub of subs) {
      if (existing.has(sub.toLowerCase())) continue;
      const { rows: ins } = await pool.query(
        `INSERT INTO expense_categories (name, class, ledger, monthly_pct, parent_id) VALUES ($1, $2, 'business', $3, $4) RETURNING id`,
        [sub, klass, JSON.stringify(EVEN_MONTHLY_PCT), parentId]
      );
      existing.set(sub.toLowerCase(), ins[0].id);
      added.push(sub);
    }
  }
  res.json({ added });
}));

export default router;
