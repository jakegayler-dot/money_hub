/** A headline figure. With onClick it's a button that opens what's behind the number. */
export default function MetricCard({ label, value, sub, tone, onClick, active }) {
  const toneClass = tone === 'positive' ? 'positive' : tone === 'negative' ? 'negative' : '';
  const body = (
    <>
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${toneClass}`}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </>
  );
  if (!onClick) return <div className="metric-card">{body}</div>;
  return (
    <button type="button" className={`metric-card metric-card-button${active ? ' active' : ''}`} aria-expanded={!!active} onClick={onClick}>
      {body}
    </button>
  );
}
