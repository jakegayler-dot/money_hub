// GST/HST moving between the farm and CRA — a refund deposit or a
// remittance — is a transfer, not income or spending. These spot it on a
// bank line so it can be held for linking to its quarter instead of being
// counted for income tax. Personal GST/HST credit, carbon rebate and child
// benefit payments (also from CRA) are excluded.
const GST = /\b(gst|hst)\b|gst\/hst|gsthst/i;
const CRA = /\b(cra|canada|revenue|receiver|rec gen|govt|gov|refund|rfnd|remit|remittance|tax)\b/i;
const NOT_BUSINESS = /\b(credit|gstc|gsthstc|carbon|climate|ccb|child|cctb|cdb|benefit)\b/i;

export function looksLikeCraGst(text) {
  const t = String(text || '');
  if (NOT_BUSINESS.test(t)) return false;
  return (GST.test(t) && CRA.test(t)) || /receiver\s*gen(eral)?/i.test(t);
}

/** SQL condition on a transaction alias `t` (description + payee name via `p`). */
export const CRA_GST_SQL = `(
  (COALESCE(t.description, '') || ' ' || COALESCE(p.name, '')) ~* '(\\mgst\\M|\\mhst\\M|gst/hst|gsthst)'
  AND (COALESCE(t.description, '') || ' ' || COALESCE(p.name, '')) ~* '(\\mcra\\M|canada|revenue|receiver|govt|\\mgov\\M|refund|rfnd|remit|\\mtax\\M)'
  OR (COALESCE(t.description, '') || ' ' || COALESCE(p.name, '')) ~* 'receiver\\s*gen'
) AND NOT (COALESCE(t.description, '') || ' ' || COALESCE(p.name, '')) ~* '(\\mcredit\\M|gstc|carbon|climate|\\mccb\\M|child|benefit)'`;
