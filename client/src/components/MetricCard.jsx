export default function MetricCard({ label, value, sub, tone }) {
  const toneClass = tone === 'positive' ? 'positive' : tone === 'negative' ? 'negative' : '';
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${toneClass}`}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}
