import { Link } from 'react-router-dom';

/** A headline figure. With onClick it's a button that opens what's behind the number; with `to`, a link to its page. */
export default function MetricCard({ label, value, sub, tone, onClick, active, to }) {
  const toneClass = tone === 'positive' ? 'positive' : tone === 'negative' ? 'negative' : '';
  const body = (
    <>
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${toneClass}`}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </>
  );
  if (to) return <Link to={to} className="metric-card metric-card-link">{body}</Link>;
  if (!onClick) return <div className="metric-card">{body}</div>;
  return (
    <button type="button" className={`metric-card metric-card-button${active ? ' active' : ''}`} aria-expanded={!!active} onClick={onClick}>
      {body}
    </button>
  );
}
