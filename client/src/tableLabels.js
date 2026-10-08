// Gives every table cell the name of its column (data-label) so that on a
// phone the CSS can show each row as a stacked card — "AMOUNT  -$412.50" —
// instead of a table you have to scroll sideways. Also marks money and date
// cells (data-num) so they never break across two lines.
//
// Runs on every DOM change, so pages don't have to do anything. Only data-*
// attributes are touched; React never sets those, so it won't fight them.

const NUMERIC = /^[\s+\-−]*\$?[\d,]+(\.\d+)?\s*%?$|^\d{4}-\d{2}-\d{2}$/;

function labelTable(table) {
  if (table.hasAttribute('data-nostack')) return; // e.g. the ledger spreadsheet scrolls sideways instead
  const head = table.tHead && table.tHead.rows[table.tHead.rows.length - 1];
  const labels = [];
  if (head) {
    for (const th of head.cells) {
      const text = th.textContent.trim();
      for (let i = 0; i < (th.colSpan || 1); i++) labels.push(text);
    }
  }
  table.setAttribute('data-stack', '');
  for (const body of table.tBodies) {
    for (const row of body.rows) {
      let col = 0;
      for (const td of row.cells) {
        const span = td.colSpan || 1;
        const label = span > 1 ? '' : labels[col] || '';
        if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
        const num = NUMERIC.test(td.textContent);
        if (num !== td.hasAttribute('data-num')) td.toggleAttribute('data-num', num);
        col += span;
      }
    }
  }
}

let queued = false;
function run() {
  queued = false;
  document.querySelectorAll('main table').forEach(labelTable);
}

export function startTableLabels() {
  const observer = new MutationObserver(() => {
    if (!queued) { queued = true; requestAnimationFrame(run); }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  run();
}
