// Delete an attached PDF or photo (a duplicate, the wrong file). Asks first.
export async function removeDoc(d, what = 'this document') {
  const kind = d.mime === 'application/pdf' ? 'PDF' : 'photo';
  if (!window.confirm(`Delete ${what} (${kind})? It's removed from Money Hub for good.`)) return false;
  const r = await fetch(`/api/receipts/${d.id}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 404) { window.alert(`Couldn't delete it (HTTP ${r.status}).`); return false; }
  return true;
}
