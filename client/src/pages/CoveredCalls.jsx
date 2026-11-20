// The covered-call desk (Jake, Nov 17: "watches for drops on large stocks that offer 0dte or close to call options. When the
// stock drops a certain amount, the goal is to buy that stock and start writing call options to generate cash ... a calculator
// of the positions that show max gain and loss at certain calls and puts ... recommend call and puts and position sizing ...
// have Andrew or Mike offer guidance"). Rebuilt Nov 20 (Jake: "it now uses put spreads ... significantly improve the covered call
// strategy page ... integration from the market data site ... really sleek and advanced looking with dynamic graphs and
// notifications on stocks, gamma, theta, etc. any big moves"): the live pieces are in CoveredLive.jsx. Server: lib/options
// (stock prices live from Yahoo's chart feed, options from MarketData.app on his token), /api/options. Money Hub never trades.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { localToday } from '../format.js';
import './coveredCalls.css';
import MarketClock from './MarketClock.jsx';
import { send, usd, cad, plain, pctS, short, day, asOf, sign, signed, nyToday, setFx, getFx, pricesWords } from './ccFormat.js';
import { Num, Spark, PriceChart, PayoffChart, StrikeMap, Greeks, LegLadder, PutStructure, Signals, AlertCenter, DataBar, Tape, IncomeChart, SpreadBuilder } from './CoveredLive.jsx';

// The payoff chart (CoveredLive.jsx): at the nearest expiry, and today by model.
const Payoff = PayoffChart;

// ---------------------------------------------------------------- stocks to write calls on
// How often a stock's options expire (Nov 17: "options expiring at most every 3 days, not an option expiring within 3 days").
const cadenceLabel = (c) => (!c ? 'too few listed' : c.max <= 3 && c.min === 1 ? 'every day' : c.min === 7 && c.max === 7 ? 'weekly'
  : c.min === c.max ? `every ${c.max} days` : `every ${c.min}–${c.max} days`);

// One list, sorted by the difference (Jake, Nov 17: "the difference between avg put daily cost (on trading days) on long horizon
// puts that are $10 otm, and avg short term daily calls $5 otm. then sort the stocks by the difference"): what the short-term
// calls pay a trading day on average, less what the long-horizon puts cost, for 100 shares. His watchlist and the wider list
// together; a stock whose options don't expire often enough sits at the bottom, greyed.
// The contract behind a column's average (Nov 18: "doesn't seem to have any data on option prices"): strike, expiry, the
// price it was taken at (a call's bid, a put's ask, per share, US$ as the broker shows it) and its delta.
const optDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
function OptLine({ o, kind }) {
  if (!o) return null;
  const px = kind === 'call' ? o.bid : o.ask;
  return (
    <span className="cc-opt">
      <span>{o.strike} {kind === 'call' ? 'C' : 'P'} {optDay(o.expiry)}</span>
      <span>US${Number(px).toFixed(2)} {kind === 'call' ? 'bid' : 'ask'}{o.delta != null ? ` · Δ ${Number(o.delta).toFixed(2)}` : ''}</span>
    </span>
  );
}

// The day's five (Jake, Nov 19: "5 recommended positions for the day based on call option value today/tomorrow vs put option
// cost long term"): from every stock the page reads, 100 shares with the call expiring today or the next trading day by his
// rule and the cheapest long-horizon put by his rule, ranked by what the call pays a trading day less the put and the margin
// interest. His rules applied to today's prices; the trade is his. Tap one to open it in the calculator.
// A stock's next earnings report (Nov 19: "factor in earnings ... ie. earnings report calendar"), from Nasdaq's calendar.
function EarningsLine({ e, put = true }) {
  if (!e) return null;
  const when = `${optDay(e.date)}, ${e.time}`;
  return <span className={`cc-earn-line${e.before_call ? ' warn' : ''}`}>
    Reports {when}{e.before_call ? ': before the call expires' : put && e.before_put ? ': the put covers it' : ''}
  </span>;
}

function TodayFive({ scan, onLoad }) {
  const five = scan?.today_five || [];
  if (!scan) return null;
  const whenIs = (iso) => (iso === nyToday() ? 'today' : `${optDay(iso)}`);
  const noPrices = !scan.priced_count;
  return (
    <div className="panel cc-panel">
      <div className="panel-header spend-header">
        <span>Today’s five</span>
        <span className="cc-faint">a call expiring today or next session against a long-term put, one lot each, by your rules</span>
      </div>
      {!five.length
        ? <p className="cc-faint cc-pad">{noPrices
          ? 'No stock’s options have been priced today. Tap a stock in the list below to price it (each takes about 16 of the day’s option prices); the ones that come out ahead rank here.'
          : `Of the ${scan.priced_count} stock${scan.priced_count === 1 ? '' : 's'} priced, none comes out ahead right now: no call expiring today or next session pays more a trading day than its put and the interest cost.`}</p>
        : (
          <div className="table-scroll">
            <table className="cc-table cc-five">
              <thead><tr>
                <th>#</th><th>Stock</th>
                <th>Sell the call</th><th>Buy the put</th>
                <th className="num" title="The call a trading day, less the put a trading day and the margin interest, for one lot">Net a trading day</th>
                <th className="num">Max loss</th><th className="num">Capital</th><th className="num">Breakeven</th><th className="num">Lots</th>
              </tr></thead>
              <tbody>
                {five.map((f, i) => (
                  <tr key={f.symbol} onClick={() => onLoad({ symbol: f.symbol, shares: 100, cost: f.price, legs: f.legs, idea: true })} title="Open it in the calculator">
                    <td className="cc-faint">{i + 1}</td>
                    <td><b>{f.symbol}</b><span className="cc-opt"><span>{usd(f.price, 2)}{f.day_pct != null ? ` · ${pctS(f.day_pct)} today` : ''}</span>
                      {f.earnings ? <EarningsLine e={f.earnings} /> : <span>no report in the calendar{scan.earnings?.through ? ` to ${optDay(scan.earnings.through)}` : ''}</span>}</span></td>
                    <td>{f.call.strike} C {whenIs(f.call.expiry)} at {usd(f.call.bid, 2)}
                      <span className="cc-opt"><span>{cad(f.call.per_day)} a trading day{f.called_away_chance != null ? ` · ${f.called_away_chance}% chance called` : ''}</span></span></td>
                    <td>{f.put.strike} P {optDay(f.put.expiry)} at {usd(f.put.ask, 2)}
                      <span className="cc-opt"><span>{cad(f.put.per_day)} a trading day over {f.put.days}</span></span></td>
                    <td className={`num cc-diff ${sign(f.net_per_day)}`}>{signed(f.net_per_day)}
                      <span className="cc-opt"><span>after {cad(f.interest_per_day, 2)} interest</span>{f.on_capital_pct_year != null && <span>{f.on_capital_pct_year.toFixed(0)}% a year on capital</span>}</span></td>
                    <td className="num neg">{f.max_loss != null ? cad(f.max_loss) : '—'}{f.days_to_earn_max_loss != null && <span className="cc-opt"><span>earned back in {f.days_to_earn_max_loss} days</span></span>}</td>
                    <td className="num">{cad(f.capital)}</td>
                    <td className="num">{f.breakevens?.length ? usd(f.breakevens[0], 2) : '—'}</td>
                    <td className="num">{f.lots == null ? <span className="cc-faint">set capital</span> : f.lots}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {scan.left_out_earnings?.length > 0 && (
        <p className="cc-pad cc-left-out"><b>Left out, reporting before the call expires</b> (the premium is the market pricing the report, and the shares can gap):{' '}
          {scan.left_out_earnings.map((x, i) => <span key={x.symbol}>{i ? '; ' : ''}<b>{x.symbol}</b> {optDay(x.earnings.date)} {x.earnings.time}, its {x.call.strike} call would pay {cad(x.net_per_day)} a day</span>)}.</p>
      )}
      {scan.earnings && (scan.earnings.error || !scan.earnings.days_read) && (
        <p className="cc-pad review-error">{scan.earnings.error || (scan.earnings.running ? 'Reading the earnings calendar: the five may still include a stock that reports before its call expires.' : 'The earnings calendar hasn’t been read yet.')}</p>
      )}
      {five.length > 0 && <p className="cc-faint cc-pad">Your rules applied to the {scan.priced_count} stock{scan.priced_count === 1 ? '' : 's'} priced, at today’s stock prices{five.some((f) => f.option_prices?.modelled) ? ' (option prices estimated from the last ones read)' : ''}: the call at least US${scan.call_otm} above the price, the put at least US${scan.put_otm} below. Not advice; the trade is yours. Tap one to work it in the calculator.</p>}
    </div>
  );
}

function Watchlist({ scan, err, selected, onPick, rules, saveRules }) {
  const [add, setAdd] = useState('');
  const [all, setAll] = useState(false);
  const addOne = () => {
    const s = add.trim().toUpperCase();
    if (!s) return;
    saveRules({ watchlist: [...rules.watchlist, s] }); setAdd('');
  };
  const gap = (s) => (s.error || !s.carry || s.carry.gap == null ? -Infinity : s.carry.gap);
  const rank = (s) => (s.error ? 0 : s.qualifies ? 4 : s.priced ? 3 : s.watched ? 2 : 1);
  const everything = scan ? [...scan.stocks, ...(scan.wide || [])] : [];
  const sorted = [...everything].sort((a, b) => rank(b) - rank(a) || gap(b) - gap(a) || Math.abs(b.day_pct || 0) - Math.abs(a.day_pct || 0));
  // The wider list is long: until he asks for all of it, the ones he watches, the ones priced, and the day's big movers.
  const rows = all ? sorted : sorted.filter((s) => s.watched || s.priced || s.triggered || Math.abs(s.day_pct || 0) >= rules.alert_move_pct);
  const hidden = sorted.length - rows.length;
  const o = scan?.data?.options;
  return (
    <div className="panel cc-panel">
      <div className="panel-header spend-header">
        <span>Stocks to write calls on</span>
        <span className="cc-faint">priced ones first, by what the calls pay less what the puts cost a trading day, for 100 shares</span>
      </div>
      {err && <p className="review-error cc-pad">{err}</p>}
      {!scan && !err && <p className="cc-faint cc-pad">Reading the market…</p>}
      {scan && (
        <div className="table-scroll">
          <table className="cc-table cl-watch">
            <thead><tr><th>Stock</th><th>Today</th><th className="num">Price</th><th className="num">Move</th><th className="num cc-wide-only" title={`Against its highest close of the last ${rules.high_days} days`}>From high</th>
              <th className="num" title={`The average, over the expiries within ${rules.call_max_days} days, of the first call at least US$${rules.call_otm} above the price, at the bid, for each trading day to its expiry. Under it: the call that pays the most a trading day, its bid and delta.`}>Calls US${rules.call_otm} out</th>
              <th className="num" title={`The average, over the expiries ${rules.put_days_min} to ${rules.put_days_max} days out, of the first put at least US$${rules.put_otm} below the price, at the ask, for each trading day to its expiry. Under it: the cheapest put a trading day, and the same put as a spread.`}>Puts US${rules.put_otm} out</th>
              <th className="num" title="Calls less puts, a trading day, for 100 shares">Difference</th>
              <th className="cc-wide-only">Options expire</th><th title="The next earnings report (Nasdaq's calendar)">Earnings</th><th /><th /></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.symbol} className={`${selected === s.symbol ? 'on' : ''} ${s.triggered ? 'dropped' : ''} ${!s.error && s.priced && !s.qualifies ? 'cc-dim' : ''}`} onClick={() => !s.error && onPick(s.symbol)}>
                  <td><b>{s.symbol}</b></td>
                  {s.error ? <td colSpan={9} className="cc-faint">{s.error}</td> : <>
                    <td><Spark data={s.spark} base={s.prev_close} /></td>
                    <td className="num"><Num v={s.price} f={(x) => usd(x, 2)} /></td>
                    <td className={`num ${sign(s.day_pct)}`}>{pctS(s.day_pct, 2)}</td>
                    <td className="num cc-wide-only">{s.from_high_known ? pctS(s.from_high_pct) : <span className="cc-faint">…</span>}</td>
                    {s.priced ? <>
                      <td className="num" title={s.carry ? `average of ${s.carry.calls} expir${s.carry.calls === 1 ? 'y' : 'ies'}, a trading day` : ''}>
                        {s.carry ? cad(s.carry.call_per_day) : '—'}<OptLine o={s.carry?.call} kind="call" /></td>
                      <td className="num" title={s.carry?.puts ? `average of ${s.carry.puts} expir${s.carry.puts === 1 ? 'y' : 'ies'}, a trading day` : ''}>
                        {s.carry?.put_per_day != null ? cad(s.carry.put_per_day) : '—'}<OptLine o={s.carry?.put} kind="put" />
                        {s.put_spread && <span className="cc-opt"><span title="The same put with one your spread width lower sold against it">as a {s.put_spread.high_strike}/{s.put_spread.low_strike} spread {cad(s.put_spread.per_day, 2)} a day</span></span>}</td>
                      <td className={`num cc-diff ${s.carry?.gap != null ? sign(s.carry.gap) : ''}`} title={s.carry?.after_interest != null ? `${cad(s.carry.after_interest)} after ${cad(s.carry.interest_per_day, 2)} of margin interest` : ''}>{s.carry?.gap != null ? signed(s.carry.gap) : '—'}
                        {s.carry?.on_capital_pct_year != null && <span className="cc-opt"><span>{s.carry.on_capital_pct_year.toFixed(0)}% a year on capital</span>
                          <span>{s.carry.days_to_earn_max_loss != null ? `max loss back in ${s.carry.days_to_earn_max_loss} days` : 'not earning after interest'}</span></span>}</td>
                      <td className="cc-wide-only">{cadenceLabel(s.cadence)}{!s.often && <span className="cc-faint"> · not often enough</span>}</td>
                    </> : <td colSpan={4} className="cc-faint cl-unpriced">options not priced: tap to price them</td>}
                    <td>{s.earnings ? <>{optDay(s.earnings.date)}{s.earnings.before_call ? <span className="badge warn" title={`Reports ${s.earnings.time}, before the call priced here expires: its premium is inflated by the report`}> BEFORE CALL</span> : null}<span className="cc-opt"><span>{s.earnings.time}</span></span></> : <span className="cc-faint">—</span>}</td>
                  </>}
                  <td>{s.triggered && <span className="badge warn" title={s.why.join('; ')}>DROPPED</span>}</td>
                  <td>{s.watched
                    ? <button type="button" className="small-link" title="Stop watching" onClick={(e) => { e.stopPropagation(); saveRules({ watchlist: rules.watchlist.filter((x) => x !== s.symbol) }); }}>×</button>
                    : <button type="button" className="small-link" title="Add to your watchlist" onClick={(e) => { e.stopPropagation(); saveRules({ watchlist: [...rules.watchlist, s.symbol] }); }}>+</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="cc-row cc-pad">
        <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Add a stock (e.g. TSLA)" onKeyDown={(e) => e.key === 'Enter' && addOne()} />
        <button type="button" className="small secondary" onClick={addOne}>Watch</button>
        {scan && (hidden > 0 || all) && <button type="button" className="small-link" onClick={() => setAll(!all)}>{all ? 'only mine, the priced and the movers' : `show all ${sorted.length}`}</button>}
        {scan && <span className="cc-faint">
          Tap a stock to price its options and work out a trade{o?.has_token ? ` (about ${scan.data.plan_cost} of today’s option prices${o.remaining != null ? `; ${o.remaining} left` : ''})` : ''} ·
          {' '}{scan.priced_count} of {scan.stock_count} priced · a stock counts with options at least every {rules.expiry_every_days} days{rules.min_carry > 0 ? ` and a difference of ${plain(rules.min_carry)}` : ''} ·
          {' '}prices live, {asOf(scan.as_of)}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one leg in the calculator
function LegRow({ leg, symbol, expiries, onChange, onRemove }) {
  const [strikes, setStrikes] = useState(null);
  const [q, setQ] = useState(null);       // this leg's price as last read: { bid, ask, delta, iv, modelled }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!leg.expiry) return undefined;
    let live = true;
    send('GET', `/api/options/strikes/${symbol}?expiry=${leg.expiry}`).then((d) => live && setStrikes(d)).catch(() => live && setStrikes(null));
    return () => { live = false; };
  }, [symbol, leg.expiry]);
  useEffect(() => { setQ(null); setErr(null); }, [leg.type, leg.expiry, leg.strike]);
  const list = strikes ? (leg.type === 'call' ? strikes.calls : strikes.puts) : [];
  // A strike's price is asked for when it's chosen (each option price is billed, so the list itself carries none).
  const priceIt = (base) => {
    if (!(Number(base.strike) > 0) || !base.expiry) return;
    setBusy(true); setErr(null);
    send('GET', `/api/options/leg/${symbol}?type=${base.type}&strike=${base.strike}&expiry=${base.expiry}`)
      .then((c) => { setQ(c); onChange({ ...base, premium: base.side === 'short' ? c.bid : c.ask, iv: c.iv ?? base.iv, delta: c.delta ?? base.delta }); })
      .catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  const setStrike = (k) => { const next = { ...leg, strike: Number(k) }; onChange(next); priceIt(next); };
  const known = list.some((x) => x.strike === Number(leg.strike));
  return (
    <div className="cc-leg">
      <select value={`${leg.side}-${leg.type}`} onChange={(e) => { const [side, type] = e.target.value.split('-'); onChange({ ...leg, side, type }); }} aria-label="Buy or sell, call or put">
        <option value="short-call">Sell call</option><option value="long-put">Buy put</option>
        <option value="short-put">Sell put</option><option value="long-call">Buy call</option>
      </select>
      <select value={leg.expiry} onChange={(e) => onChange({ ...leg, expiry: e.target.value })} aria-label="Expiry">
        {expiries.map((e) => <option key={e} value={e}>{short(e)}</option>)}
      </select>
      <select value={leg.strike || ''} onChange={(e) => setStrike(e.target.value)} aria-label="Strike">
        <option value="">Strike</option>
        {leg.strike && !known ? <option value={leg.strike}>{leg.strike}</option> : null}
        {list.map((c) => <option key={c.strike} value={c.strike}>{c.strike}</option>)}
      </select>
      <label className="cc-mini">Price<input type="number" step="0.01" min="0" value={leg.premium} onChange={(e) => onChange({ ...leg, premium: e.target.value })} /></label>
      <label className="cc-mini">Contracts<input type="number" step="1" min="1" value={leg.contracts} onChange={(e) => onChange({ ...leg, contracts: e.target.value })} /></label>
      <span className="cc-faint">{busy ? 'pricing…' : err ? <span className="review-error">{err}</span> : q ? `bid ${q.bid.toFixed(2)} · ask ${q.ask.toFixed(2)}${q.delta != null ? ` · Δ ${Math.abs(q.delta).toFixed(2)}` : ''}${q.modelled ? ' · est.' : ''}`
        : leg.strike ? <button type="button" className="small-link" onClick={() => priceIt(leg)} title="Reads this one option's price">price it now</button> : ''}</span>
      <button type="button" className="small-link" onClick={onRemove} title="Remove">×</button>
    </div>
  );
}

// ---------------------------------------------------------------- the rules' pick, the calculator, Mike
// loaded: one of his positions to put in the calculator (Nov 17: "Make it so I can load my positions into the calculator").
const fromPosition = (p) => ({
  shares: p.shares, cost: p.cost,
  // Each leg keeps the day it was opened (or the position's, as the desk takes it), so the calculator's figures a trading day are
  // the position's own (Nov 18).
  legs: (p.legs || []).filter((l) => l.expiry >= nyToday()).map((l) => {
    const seen = (p.open_legs || []).find((o) => o.type === l.type && o.side === l.side && Number(o.strike) === Number(l.strike) && o.expiry === l.expiry);
    return { ...l, premium: Number(l.premium), contracts: Number(l.contracts) || 1, ...(!l.since && seen?.since ? { since: seen.since } : {}) };
  }),
});
function Desk({ symbol, rules, onSaved, loaded, onClose }) {
  const [from, setFrom] = useState(null); // the position in the calculator, or null for the rules' pick
  const calcRef = useRef(null);
  const rootRef = useRef(null);
  const showCalc = () => setTimeout(() => calcRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState(null);
  const [pos, setPos] = useState(null); // { shares, cost, legs }
  const [figs, setFigs] = useState(null);
  const [mike, setMike] = useState({ busy: false, reply: null, err: null, q: '' });
  const [saved, setSaved] = useState(null);

  const fromPlan = (p) => ({
    shares: Math.max(100, p.sizing.shares || 100), cost: p.price,
    legs: [
      p.call && { type: 'call', side: 'short', strike: p.call.strike, expiry: p.call.expiry, premium: p.call.bid, contracts: Math.max(1, p.sizing.lots || 1), iv: p.call.iv, delta: p.call.delta },
      p.put && { type: 'put', side: 'long', strike: p.put.strike, expiry: p.put.expiry, premium: p.put.ask, contracts: Math.max(1, p.sizing.lots || 1), iv: p.put.iv, delta: p.put.delta },
    ].filter(Boolean),
  });
  useEffect(() => {
    setPlan(null); setErr(null); setFigs(null); setMike({ busy: false, reply: null, err: null, q: '' }); setSaved(null);
    send('GET', `/api/options/plan/${symbol}`).then((p) => {
      setPlan(p);
      if (loaded?.symbol === symbol) { setPos(fromPosition(loaded)); setFrom(loaded.idea ? null : loaded); showCalc(); }
      else { setPos(fromPlan(p)); setFrom(null); setTimeout(() => rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }
    }).catch((e) => setErr(e.message));
  }, [symbol, rules]);
  useEffect(() => { // a position loaded on the stock already open
    if (!loaded || loaded.symbol !== symbol || plan?.symbol !== symbol) return;
    setPos(fromPosition(loaded)); setFrom(loaded.idea ? null : loaded); setSaved(null); showCalc(); // one of today’s five is a new trade, not his position
  }, [loaded]);
  useEffect(() => {
    if (!plan || !pos) return;
    const t = setTimeout(() => send('POST', '/api/options/evaluate', { position: { price: plan.price, ...pos } }).then(setFigs).catch((e) => setErr(e.message)), 150);
    return () => clearTimeout(t);
  }, [plan, pos]);

  const [expiries, setExpiries] = useState([]);
  useEffect(() => { send('GET', `/api/options/strikes/${symbol}`).then((d) => setExpiries(d.expiries)).catch(() => {}); }, [symbol]);

  if (err) return <div className="panel cc-panel"><p className="review-error cc-pad">{err}</p></div>;
  if (!plan || !pos) return <div className="panel cc-panel"><p className="cc-faint cc-pad">Pricing {symbol}’s options…</p></div>;

  const setLeg = (i, l) => setPos({ ...pos, legs: pos.legs.map((x, j) => (j === i ? l : x)) });
  const describe = () => {
    const legs = pos.legs.map((l) => `${l.side === 'short' ? 'sell' : 'buy'} ${l.contracts} ${symbol} ${l.expiry} ${l.strike} ${l.type}${Number(l.contracts) > 1 ? 's' : ''} at US$${Number(l.premium).toFixed(2)}`).join('; ');
    return `${pos.shares} shares of ${symbol} at US$${Number(pos.cost).toFixed(2)} (price now US$${plan.price.toFixed(2)})${legs ? `; ${legs}` : ''}.`;
  };
  const askMike = () => {
    const q = mike.q.trim() || 'What does this position earn and risk, and where do my rules look loose or tight?';
    setMike({ ...mike, busy: true, err: null, reply: null });
    send('POST', '/api/advisor/ask', { text: `Covered-call desk: ${describe()} ${q}` })
      .then((d) => setMike((m) => ({ ...m, busy: false, reply: d.reply })))
      .catch((e) => setMike((m) => ({ ...m, busy: false, err: e.message })));
  };
  const save = (status) => send('POST', '/api/options/positions', {
    symbol, shares: pos.shares, cost: pos.cost, status, opened_on: localToday(),
    legs: pos.legs, premium_collected: status === 'open' ? pos.legs.reduce((a, l) => a + (l.side === 'short' ? 1 : -1) * Number(l.premium) * Number(l.contracts) * 100, 0) : 0,
  }).then(() => { setSaved(status); onSaved(); }).catch((e) => setErr(e.message));
  // His own entry, changed in the calculator: shares, cost and the legs; options cash is left as it is.
  const update = () => send('PATCH', `/api/options/positions/${from.id}`, { shares: Number(pos.shares), cost: Number(pos.cost), legs: pos.legs })
    .then(() => { setSaved('updated'); onSaved(); }).catch((e) => setErr(e.message));

  const q = plan.quote;
  return (
    <div className="panel cc-panel cc-desk" ref={rootRef}>
      <div className="panel-header spend-header">
        <span>Work out a trade: {symbol} · {usd(q.price, 2)} <span className={`cc-faint ${sign(q.change_pct)}`}>{pctS(q.change_pct, 2)} today</span> <span className="cc-faint">· options {pricesWords(plan.option_prices)}</span></span>
        <span className="cc-actions">{plan.drop?.triggered && <span className="badge warn">{plan.drop.why.join('; ')}</span>}
          <button type="button" className="small-link" onClick={onClose} title="Close the calculator">close ×</button></span>
      </div>

      <div className="cc-pick cc-pad">
        <div className="cc-pick-head">What your rules pick</div>
        <div className="cc-pick-grid">
          <div><span className="cc-k">Call to sell</span>{plan.call ? <b>{plan.call.strike} · {short(plan.call.expiry)}</b> : <b>none fits</b>}
            {plan.call && <span className="cc-faint">bid {plan.call.bid.toFixed(2)} · delta {plan.call.delta.toFixed(2)} · {cad(plan.call.per_day)} a trading day a contract</span>}</div>
          <div><span className="cc-k">Put to buy</span>{plan.rules.protect ? (plan.put ? <b>{plan.put.strike} · {short(plan.put.expiry)}</b> : <b>none fits</b>) : <b>off</b>}
            {plan.put && <span className="cc-faint">ask {plan.put.ask.toFixed(2)} · {cad(plan.put.cost_per_day)} a trading day a contract</span>}</div>
          <div><span className="cc-k">Size</span><b>{plan.sizing.lots} lot{plan.sizing.lots === 1 ? '' : 's'} ({plan.sizing.shares} shares)</b>
            <span className="cc-faint">{plan.sizing.money_in ? `${cad(plan.sizing.money_in)} of your capital${plan.rules.margin_pct < 100 ? ` at ${plan.rules.margin_pct}% margin` : ''}` : ''}</span></div>
        </div>
        <ul className="cc-why">{[...plan.reasons, ...plan.sizing.limits].map((r) => <li key={r}>{r}</li>)}</ul>
        {plan.put_spread && (
          <div className="cl-put-line insured cl-spread-pick">
            <span className="cl-badge put">Or as a spread</span>
            <span>Buy the same <b>{plan.put_spread.high_strike}</b> put and sell the <b>{plan.put_spread.low_strike}</b> under it (your US${plan.rules.spread_width} width): <b>{cad(plan.put_spread.cost)}</b> a lot instead of {cad(plan.put_spread.plain_put_cost)}, {cad(plan.put_spread.per_day, 2)} a trading day.
              It pays for a fall from {plan.put_spread.high_strike} to {plan.put_spread.low_strike}; below {plan.put_spread.low_strike} the shares fall unprotected (one lot is {cad(plan.put_spread.lot.loss_at_protection_end)} there, against a worst case of {cad(plan.put_spread.single_put.max_loss)} with the put alone).{' '}
              <button type="button" className="small secondary" onClick={() => setPos({ ...pos, legs: [...pos.legs.filter((l) => l.type !== 'put'), ...plan.put_spread.legs.filter((l) => l.type === 'put').map((l) => ({ ...l, contracts: pos.legs.find((x) => x.type === 'call')?.contracts || Math.max(1, plan.sizing.lots || 1) }))] })}>Use the spread</button></span>
          </div>
        )}
        {plan.call_choices.length > 1 && (
          <div className="cc-alts">The short expiries, most a trading day first: {plan.call_choices.map((c) => (
            <button key={c.expiry} type="button" className="small secondary" onClick={() => setPos({ ...pos, legs: [
              ...pos.legs.filter((l) => !(l.type === 'call' && l.side === 'short')),
              { type: 'call', side: 'short', strike: c.strike, expiry: c.expiry, premium: c.bid, contracts: pos.legs.find((l) => l.type === 'call')?.contracts || 1, iv: c.iv, delta: c.delta },
            ] })}>{short(c.expiry)}: {c.strike} for {c.bid.toFixed(2)} ({cad(c.per_day)}/day)</button>
          ))}</div>
        )}
      </div>

      <div className="cc-calc cc-pad" ref={calcRef}>
        <div className="cc-pick-head">Calculator{from ? <>: your position <span className="cc-faint">({from.shares} shares at {usd(from.cost, 2)}{from.source === 'broker' ? ', from your broker' : ''})</span></> : ''}{' '}
          {from && <button type="button" className="small-link" onClick={() => setPos(fromPosition(from))}>start over from it</button>}{' '}
          <button type="button" className="small-link" onClick={() => { setPos(fromPlan(plan)); setFrom(null); setSaved(null); }}>{from ? 'your rules’ pick instead' : 'back to your rules’ pick'}</button></div>
        <div className="cc-row">
          <label className="cc-mini">Shares<input type="number" step="100" min="0" value={pos.shares} onChange={(e) => setPos({ ...pos, shares: e.target.value })} /></label>
          <label className="cc-mini">Cost a share<input type="number" step="0.01" min="0" value={pos.cost} onChange={(e) => setPos({ ...pos, cost: e.target.value })} /></label>
        </div>
        {pos.legs.map((l, i) => (
          <LegRow key={i} leg={l} symbol={symbol} expiries={expiries.length ? expiries : [l.expiry]} onChange={(x) => setLeg(i, x)}
            onRemove={() => setPos({ ...pos, legs: pos.legs.filter((_, j) => j !== i) })} />
        ))}
        <div className="cc-row">
          <button type="button" className="small secondary" onClick={() => setPos({ ...pos, legs: [...pos.legs, { type: 'call', side: 'short', strike: 0, expiry: expiries[0], premium: 0, contracts: 1 }] })}>+ Call</button>
          <button type="button" className="small secondary" onClick={() => setPos({ ...pos, legs: [...pos.legs, { type: 'put', side: 'long', strike: 0, expiry: expiries.find((e) => e >= (plan.put?.expiry || '')) || expiries[0], premium: 0, contracts: 1 }] })}>+ Put</button>
          <button type="button" className="small secondary" title="A put to sell: under a put you hold it makes a spread" onClick={() => setPos({ ...pos, legs: [...pos.legs, { type: 'put', side: 'short', strike: 0, expiry: pos.legs.find((l) => l.type === 'put')?.expiry || expiries.find((e) => e >= (plan.put?.expiry || '')) || expiries[0], premium: 0, contracts: 1 }] })}>+ Sell a put</button>
        </div>

        {figs && (
          <>
            {figs.uncovered && <p className="review-error">More calls sold than shares cover: the loss has no limit if the stock runs.</p>}
            <div className="cc-figs">
              <div><span className="cc-k">Option revenue a trading day</span><b className={figs.revenue_per_day < 0 ? 'cc-neg' : ''}>{cad(figs.revenue_per_day)}</b>
                <span className="cc-faint">{figs.per_day_by_role ? `calls ${cad(figs.per_day_by_role.calls)}${figs.per_day_by_role.insurance ? ` · insurance ${cad(figs.per_day_by_role.insurance)}` : ''}${figs.per_day_by_role.income_spreads ? ` · income spreads ${signed(figs.per_day_by_role.income_spreads)}` : ''}` : `calls ${cad(figs.income_per_day)}`}{figs.interest_per_day ? ` · interest −${cad(figs.interest_per_day, 2)}` : ''}</span></div>
              <div><span className="cc-k">On the capital</span><b className={figs.on_capital_pct_year < 0 ? 'cc-neg' : ''}>{figs.on_capital_pct_year == null ? '—' : `${figs.on_capital_pct_year.toFixed(1)}% a year`}</b>
                <span className="cc-faint">{figs.on_capital_pct_day == null ? '' : `${figs.on_capital_pct_day.toFixed(3)}% a trading day of ${cad(figs.capital_needed)} tied up`}</span></div>
              <div><span className="cc-k">Against the max loss</span><b>{figs.days_to_earn_max_loss == null ? '—' : `${figs.days_to_earn_max_loss} trading days`}</b>
                <span className="cc-faint">{figs.days_to_earn_max_loss == null ? (figs.max_loss == null ? 'no limit on the loss' : 'it isn’t earning') : `of revenue to earn back a max loss of ${cad(Math.abs(figs.max_loss))} (${figs.vs_max_loss_pct_day.toFixed(2)}% of it a day)`}</span></div>
              <div><span className="cc-k">Premium in</span><b>{cad(figs.premium_in)}</b><span className="cc-faint">everything sold, in full</span></div>
              {figs.unlimited_gain && figs.gain_at_call != null
                ? <div><span className="cc-k">Gain at the call</span><b>{cad(figs.gain_at_call)}</b>
                    <span className="cc-faint">at {usd(figs.call_strike, 2)}; then {cad(figs.shares_not_called, 2)} for each US$1 higher on the {figs.shares_not_called} share{figs.shares_not_called === 1 ? '' : 's'} the call doesn’t cover</span></div>
                : <div><span className="cc-k">Max gain</span><b>{figs.unlimited_gain ? 'no cap' : cad(figs.max_gain)}</b><span className="cc-faint">{figs.max_gain_at != null ? `at ${usd(figs.max_gain_at, 2)} or above` : figs.unlimited_gain ? 'no call written' : ''}</span></div>}
              <div><span className="cc-k">Max loss</span><b>{figs.max_loss == null ? 'no limit' : cad(figs.max_loss)}</b>
                <span className="cc-faint">{figs.max_loss == null ? '' : figs.protection_ends ? `if it went to zero; ${cad(figs.loss_at_protection_end)} at ${usd(figs.protection_ends, 2)}, where the put spread stops paying` : figs.shares_without_put
                  ? `if it went to zero; ${cad(figs.shares_without_put * figs.cost)} of it is the ${figs.shares_without_put} share${figs.shares_without_put === 1 ? '' : 's'} the put doesn’t cover`
                  : figs.put_strike && figs.loss_at_put != null && figs.max_loss_at < 1 ? `if it went to zero; ${cad(figs.loss_at_put)} at the put’s ${usd(figs.put_strike, 2)}`
                  : figs.floor_from ? `about this from ${usd(figs.floor_from, 2)} down` : figs.max_loss_at != null ? (figs.max_loss_at < 1 ? 'if it went to zero' : `at ${usd(figs.max_loss_at, 2)} or below`) : ''}</span></div>
              <div><span className="cc-k">Breakeven</span><b>{figs.breakevens.length ? figs.breakevens.map((b) => usd(b, 2)).join(', ') : '—'}</b><span className="cc-faint">{figs.risk_horizon ? `held to ${short(figs.risk_horizon)}` : ''}</span></div>
              <div><span className="cc-k">Called away</span><b>{figs.called_away_chance == null ? '—' : `≈${Math.round(figs.called_away_chance)}%`}</b><span className="cc-faint">the call’s delta</span></div>
              {figs.margin_pct < 100
                ? <div><span className="cc-k">Capital needed</span><b>{cad(figs.capital_needed)}</b>
                    <span className="cc-faint">{figs.margin_pct}% of the shares{figs.put_cost ? ' and the put' : ''}; {cad(figs.borrowed)} borrowed at {figs.margin_rate}%{figs.interest_to_horizon ? `, ${cad(figs.interest_to_horizon)} interest to ${short(figs.horizon)}` : ''}</span></div>
                : <div><span className="cc-k">Money in</span><b>{cad(figs.money_in)}</b><span className="cc-faint">{figs.put_cost ? `${cad(figs.put_cost)} of it the put` : 'the shares'}</span></div>}
            </div>
            <PutStructure f={figs} />
            <Payoff curve={figs.curve} price={plan.price} breakevens={figs.breakevens} strikes={pos.legs.map((l) => Number(l.strike))} horizon={figs.horizon} />
            <p className="cc-faint">The solid line is profit or loss on {short(figs.horizon)} (the nearest expiry), a longer option at what it would still be worth then; the dashed line is the position today, by model. Max loss, break-even and the loss at a put’s strike are held to {short(figs.risk_horizon || figs.horizon)}, with nothing left in the options and the interest to then.</p>
            {figs.greeks?.legs.length > 0 && <Greeks g={figs.greeks} rules={rules} shares={Number(pos.shares) || 0} />}
            <div className="table-scroll">
              <table className="cc-table cc-scen">
                <thead><tr><th>If {symbol} is</th>{figs.scenarios.map((s) => <th key={s.pct} className="num">{pctS(s.pct)}</th>)}</tr></thead>
                <tbody>
                  <tr><td className="cc-faint">price</td>{figs.scenarios.map((s) => <td key={s.pct} className="num">{usd(s.price, 2)}</td>)}</tr>
                  <tr><td className="cc-faint">you make</td>{figs.scenarios.map((s) => <td key={s.pct} className={`num ${s.pnl < 0 ? 'neg' : 'pos'}`}>{cad(s.pnl)}</td>)}</tr>
                </tbody>
              </table>
            </div>
            {from ? (
              <div className="cc-row">
                {from.source !== 'broker' && <button type="button" className="small" onClick={update}>Save changes to this position</button>}
                <button type="button" className="small secondary" onClick={() => save('planned')}>Save as a plan</button>
                {from.source === 'broker' && <span className="cc-faint">From your broker: changes here are a what-if; the bot’s next sync keeps the record.</span>}
                {saved && <span className="cc-faint">{saved === 'updated' ? 'Position updated.' : 'Saved to your positions as a plan.'}</span>}
              </div>
            ) : (
              <div className="cc-row">
                <button type="button" className="small" onClick={() => save('open')}>I’ve put this on</button>
                <button type="button" className="small secondary" onClick={() => save('planned')}>Save as a plan</button>
                {saved && <span className="cc-faint">Saved to your positions{saved === 'planned' ? ' as a plan' : ''}.</span>}
              </div>
            )}
          </>
        )}
      </div>

      <div className="cc-mike cc-pad">
        <div className="cc-pick-head">Ask Mike</div>
        <div className="cc-row">
          <input value={mike.q} onChange={(e) => setMike({ ...mike, q: e.target.value })} placeholder="What does this earn and risk? Is the put worth it? Tax in a TFSA?"
            onKeyDown={(e) => e.key === 'Enter' && !mike.busy && askMike()} />
          <button type="button" className="small" disabled={mike.busy} onClick={askMike}>{mike.busy ? 'Mike is looking…' : 'Ask'}</button>
        </div>
        {mike.err && <p className="review-error">{mike.err}</p>}
        {mike.reply && <div className="cc-reply">{mike.reply}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- his rules
const RULE_GROUPS = [
  ['Your money', [['capital', 'Capital for this', 1000], ['margin_pct', 'Your share of the stock on margin (%; 100 = cash)', 5], ['margin_rate', 'Margin interest (% a year)', 0.05],
    ['max_position_pct', 'Most in one stock (% of capital)', 1], ['max_loss_pct', 'Most to lose on one position (% of capital)', 0.5]]],
  ['Which stocks count', [['expiry_every_days', 'Options expire at least every (days)', 1], ['min_carry', 'Calls beat puts by at least ($ a trading day, 100 shares)', 5],
    ['drop_day_pct', 'A drop: down in a day (%)', 0.5], ['drop_from_high_pct', 'or under the recent high (%)', 1], ['high_days', 'Recent high: last N days', 1]]],
  ['The short-term call', [['call_otm', 'At least this far above the price (US$)', 0.5], ['call_max_days', 'Expiring within (days)', 1]]],
  ['The long-horizon put', [['put_otm', 'At least this far below the price (US$)', 0.5], ['put_days_min', 'At least (days out)', 1], ['put_days_max', 'At most (days out)', 1], ['drop_test_pct', 'With no put, size against a fall of (%)', 1]]],
  ['Put spreads', [['spread_width', 'The two strikes this far apart (US$)', 1]]],
  ['What you’re told about', [['alert_move_pct', 'A stock moves this much in a day (%), and again at twice and three times it', 0.5], ['alert_swing_pct', 'A stock you hold moves this much in half an hour (%)', 0.25],
    ['alert_near_strike_pct', 'The price comes within this of a strike you’ve sold (%)', 0.25], ['alert_gamma', 'Gamma: exposure shifts by this many shares for US$1', 1],
    ['alert_earned_pct', 'A sold option has earned this much of its premium (%)', 5], ['alert_iv_points', 'Implied volatility moves this many points', 1]]],
];
const ALERT_KINDS = [['drop', 'A drop by your rule'], ['move', 'Big moves'], ['swing', 'Fast moves'], ['call', 'A call you sold'], ['put', 'A put you hold'], ['spread', 'Put spreads'], ['gamma', 'Gamma'], ['theta', 'Theta'], ['expiry', 'Expiry day'], ['iv', 'Volatility'], ['earnings', 'Earnings']];
function Rules({ rules, saveRules }) {
  const [f, setF] = useState(rules);
  useEffect(() => setF(rules), [rules]);
  const dirty = JSON.stringify(f) !== JSON.stringify(rules);
  const off = new Set(f.alerts_off || []);
  const toggle = (k) => { const next = new Set(off); if (next.has(k)) next.delete(k); else next.add(k); setF({ ...f, alerts_off: [...next] }); };
  return (
    <details className="panel cc-panel cc-rules">
      <summary className="panel-header spend-header"><span>Your rules</span><span className="cc-faint">{rules.capital ? `${rules.capital_currency === 'USD' ? usd(rules.capital) : plain(rules.capital)} capital` : 'no capital set'} · {rules.margin_pct < 100 ? `${rules.margin_pct}% margin at ${rules.margin_rate}%` : 'cash'} · calls US${rules.call_otm} out within {rules.call_max_days} days · {rules.protect ? `puts US$${rules.put_otm} out, ${rules.put_days_min} to ${rules.put_days_max} days` : 'no put'} · spreads US${rules.spread_width} wide · change</span></summary>
      {RULE_GROUPS.map(([title, fields]) => (
        <div key={title} className="cc-pad cc-rule-group">
          <div className="cc-pick-head">{title}</div>
          <div className="cc-rule-grid">
            {fields.map(([k, label, step]) => (
              <label key={k} className="cc-mini">{label}<input type="number" step={step} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
            ))}
            {title === 'Your money' && <label className="cc-mini">Capital is in<select value={f.capital_currency || 'CAD'} onChange={(e) => setF({ ...f, capital_currency: e.target.value })}>
              <option value="CAD">Canadian dollars</option><option value="USD">US dollars</option></select></label>}
            {title === 'Which stocks count' && <label className="cc-check"><input type="checkbox" checked={!!f.wide} onChange={(e) => setF({ ...f, wide: e.target.checked })} /> Also follow about 50 large stocks</label>}
            {title === 'The long-horizon put' && <label className="cc-check"><input type="checkbox" checked={!!f.protect} onChange={(e) => setF({ ...f, protect: e.target.checked })} /> Buy a put for protection</label>}
          </div>
          {title === 'Put spreads' && <p className="cc-faint">A starting width: set it to the one you trade. Each stock’s plan shows the put your rule picks by itself and as a spread this wide.</p>}
          {title === 'What you’re told about' && (
            <>
              <div className="cl-kinds">{ALERT_KINDS.map(([k, word]) => (
                <label key={k} className="cc-check"><input type="checkbox" checked={!off.has(k)} onChange={() => toggle(k)} /> {word}</label>
              ))}</div>
              <p className="cc-faint">Starting levels: set them to what you’d want to hear about. Checked every five minutes while the US market is open. Notes on what you hold go to the bell on this page and to Mike Burry’s chat in Andrew (and so to your phone); notes on stocks you only watch stay on this page.</p>
            </>
          )}
        </div>
      ))}
      <div className="cc-row cc-pad">
        <button type="button" className="small" disabled={!dirty} onClick={() => saveRules(f)}>Save rules</button>
        {dirty && <button type="button" className="small secondary" onClick={() => setF(rules)}>Undo</button>}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- what it has earned
// Nov 17 (Jake): "it doesnt show my option profit and loss. it should look like any asset that produces cash." The cash is his
// brokerage entries in Money Hub, sorted into calls, puts and shares by stock (server lib/options/cash.js).
function Tile({ k, v, cls = '', sub }) {
  return <div className="cc-tile"><span className="cc-k">{k}</span><b className={cls}>{v}</b>{sub && <span className="cc-faint">{sub}</span>}</div>;
}

// The page opens on what the desk has earned and holds (Nov 17: "it should look like any asset that produces cash"), now
// with the figures counting to their values, the option cash added up over time, and the whole book's greeks (Nov 20).
function Earnings({ positions, cash, ins }) {
  const open = (positions || []).filter((p) => p.status === 'open');
  const toUsd = (n) => (cash?.currency === 'CAD' && getFx() ? n / getFx() : n); // the entries' amounts, in US$ like the desk's figures
  const hasCash = !!cash?.stocks.some((s) => s.call_entries || s.put_entries);
  const calls = hasCash ? toUsd(cash.totals.calls) : null;
  const puts = hasCash ? toUsd(cash.totals.puts) : null;
  const optNet = hasCash ? calls + puts : open.reduce((a, p) => a + p.premium_collected, 0);
  const sum = (f) => open.reduce((a, p) => a + (f(p) || 0), 0);
  const sharesValue = sum((p) => (p.price || 0) * p.shares);
  const sharesPnl = sum((p) => p.stock_pnl);
  const sharesDay = sum((p) => (p.day?.change || 0) * p.shares);
  const callsDay = sum((p) => p.figures?.income_per_day); const putsDay = sum((p) => p.figures?.protection_per_day);
  const interestDay = sum((p) => p.figures?.interest_per_day); const netDay = sum((p) => p.figures?.net_after_interest_per_day ?? p.figures?.net_per_day);
  const putTo = open.flatMap((p) => p.legs.filter((l) => l.type === 'put' && l.side === 'long').map((l) => l.expiry)).sort().at(-1);
  const sales = hasCash ? cash.stocks.reduce((a, s) => a + s.call_entries, 0) : 0;
  const t = ins?.total || null;
  const paidBack = t && t.puts_paid > 0 ? Math.min(1, Math.max(0, t.calls_collected / t.puts_paid)) : null;
  const withGreeks = open.filter((p) => p.greeks);
  const book = withGreeks.length ? {
    per_1pct: withGreeks.reduce((a, p) => a + p.greeks.per_1pct, 0), theta: withGreeks.reduce((a, p) => a + p.greeks.theta, 0),
    vega: withGreeks.reduce((a, p) => a + p.greeks.vega, 0), optionsPnl: withGreeks.reduce((a, p) => a + p.greeks.options_pnl, 0),
  } : null;
  if (!positions || (!open.length && !hasCash)) return null;
  const allIn = sharesPnl + optNet;
  return (
    <div className="panel cc-panel cc-earn cl-hero">
      <div className="panel-header spend-header"><span>What it has earned</span>
        <span className="cc-faint">{hasCash && cash.totals.first ? `since ${day(cash.totals.first)}` : ''}</span></div>
      <div className="cl-hero-grid cc-pad">
        <div className="cl-hero-main">
          <span className="cc-k">All in: shares and options</span>
          <b className={`cl-big ${sign(allIn)}`}><Num v={allIn} f={(x) => signed(x)} /></b>
          <span className="cc-faint">shares <span className={sign(sharesPnl)}>{signed(sharesPnl)}</span> since you bought · options <span className={sign(optNet)}>{signed(optNet)}</span> so far</span>
          <div className="cl-hero-tiles">
            {hasCash
              ? <>
                  <Tile k="Calls collected" v={<Num v={calls} f={(x) => signed(x)} />} cls={sign(calls)} sub={`${sales} trade${sales === 1 ? '' : 's'}`} />
                  <Tile k="Puts, net" v={<Num v={puts} f={(x) => signed(x)} />} cls={sign(puts)} sub={putTo ? `cover you to ${day(putTo)}` : 'none held now'} />
                </>
              : <Tile k="Options cash so far" v={signed(optNet)} cls={sign(optNet)} sub="your broker sync’s figure: no option trades in your Money Hub entries yet" />}
            <Tile k="Coming in now" v={<><Num v={netDay} f={(x) => cad(x)} /> <small>a trading day</small></>} cls={sign(netDay)}
              sub={`calls ${cad(callsDay)}${putsDay ? ` − puts ${cad(putsDay)}` : ''}${interestDay ? ` − interest ${cad(interestDay, 2)}` : ''}`} />
            <Tile k="Shares today" v={<Num v={sharesDay} f={(x) => signed(x)} />} cls={sign(sharesDay)} sub={`worth ${cad(sharesValue)}`} />
          </div>
        </div>
        {hasCash && <IncomeChart entries={(cash.entries || []).filter((e) => e.kind === 'call' || e.kind === 'put')} toUsd={toUsd} />}
      </div>
      {book && (
        <div className="cl-book cc-pad">
          <div className="cc-pick-head">The whole book right now</div>
          <div className="cc-tiles cc-tiles-sm">
            <Tile k="A 1% move in your stocks" v={<Num v={book.per_1pct} f={(x) => cad(Math.abs(x))} />} sub="what the shares and options together gain or lose" />
            <Tile k="Time decay (theta)" v={<><Num v={book.theta} f={(x) => signed(x)} /> <small>a day</small></>} cls={sign(book.theta)} sub={book.theta >= 0 ? 'time is paying you' : 'time is costing you'} />
            <Tile k="A point of volatility (vega)" v={<Num v={book.vega} f={(x) => signed(x)} />} cls={sign(book.vega)} sub={book.vega >= 0 ? 'jumpier markets pay' : 'calmer markets pay'} />
            <Tile k="Open options, if closed now" v={<Num v={book.optionsPnl} f={(x) => signed(x)} />} cls={sign(book.optionsPnl)} sub="against what you sold and paid" />
          </div>
        </div>
      )}
      {paidBack != null && (
        <div className="cc-pad cc-meter-wrap">
          <div className="cc-pick-head">The puts are the insurance: a fixed cost the calls pay off</div>
          <div className="cc-meter" role="img" aria-label={`Calls have paid back ${Math.round(paidBack * 100)}% of the puts`}><span style={{ width: `${paidBack * 100}%` }} /></div>
          <Insurance x={t} />
        </div>
      )}
    </div>
  );
}

// One entry's sorting, changed by him: call, put, the shares or other, and which stock.
function EntryRow({ e, money, onSaved, withWord }) {
  const [kind, setKind] = useState(e.kind || '');
  const [symbol, setSymbol] = useState(e.symbol || '');
  const [word, setWord] = useState('');
  const [err, setErr] = useState(null);
  const dirty = kind !== (e.kind || '') || symbol.toUpperCase() !== (e.symbol || '') || word;
  const save = () => send('PUT', `/api/options/cash/${e.id}`, { kind, symbol, word }).then(() => { setErr(null); onSaved(); }).catch((x) => setErr(x.message));
  return (
    <tr>
      <td className="cc-nowrap">{day(e.date)}</td>
      <td className="cc-words">{e.words}{err && <span className="review-error"> {err}</span>}</td>
      <td><select value={kind} onChange={(x) => setKind(x.target.value)} aria-label="What it is">
        <option value="">What is it?</option><option value="call">Call</option><option value="put">Put</option><option value="stock">Shares</option><option value="other">Other</option></select></td>
      <td><input className="cc-sym-in" value={symbol} onChange={(x) => setSymbol(x.target.value.toUpperCase())} placeholder="Symbol" aria-label="Stock symbol" disabled={kind === 'other'} /></td>
      {withWord && <td><input className="cc-word-in" value={word} onChange={(x) => setWord(x.target.value)} placeholder="every entry that says…" title="A word in these entries, like a company's name: every entry that mentions it is filed under this stock" /></td>}
      <td className={`num ${sign(e.amount)}`}>{signed(e.amount, money)}</td>
      <td>{dirty && kind ? <button type="button" className="small" onClick={save}>Save</button> : null}</td>
    </tr>
  );
}

// The puts as insurance (Jake, Nov 17: "show me my breakeven on the puts which are essentially an insurnace policy of this
// system and therefore a fixed cost that needs to be extracted over the remaining trading days"). x: one stock's row, or the
// total, from /api/options/insurance (US$).
function Insurance({ x }) {
  if (!x) return null;
  const known = x.calls_collected != null && !(x.calls_unknown?.length);
  const even = known && x.left <= 0;
  const n = (k, word) => `${k} ${word} entr${k === 1 ? 'y' : 'ies'}`;
  return (
    <div className="cc-meter-text">
      {/* Nov 19: days of floor left, the open call against the puts, and the call premium a day to break even. */}
      <div className="cc-tiles cc-tiles-sm">
        <Tile k="Price floor left" v={x.trading_days_left == null ? '—' : `${x.trading_days_left} trading day${x.trading_days_left === 1 ? '' : 's'}`}
          sub={x.put_expiry ? `${x.calendar_days_left} calendar days, to ${day(x.put_expiry)}` : 'no put held'} />
        <Tile k="Calls − puts" v={signed(x.call_less_put)} cls={sign(x.call_less_put)}
          sub={`calls collected ${cad(x.calls_total ?? x.call_premium_now)} − puts ${cad(x.puts_paid)}`} />
        <Tile k="Call premium to break even" v={even ? 'covered' : x.needed_per_day == null ? '—' : `${cad(x.needed_per_day, 2)} a day`}
          cls={!even && x.needed_per_day != null && x.call_now_per_day < x.needed_per_day ? 'neg' : ''}
          sub={even ? 'the calls have paid for the puts' : `a trading day to the put’s expiry; the open call pays ${cad(x.call_now_per_day, 2)}`} />
      </div>
      <span>
        {x.from === 'entries' ? `The puts cost ${cad(x.puts_paid)} net (${n(x.put_entries, 'put')})` : `The puts you hold cost ${cad(x.puts_paid)}`}{x.put_expiry ? ` and cover you to ${day(x.put_expiry)}` : ''}.
        {x.calls_collected == null ? ' What the calls have paid back isn’t known: none of this stock’s trades are in your Money Hub entries, so the whole cost is still counted.'
          : ` The calls have paid back ${cad(x.calls_collected)} (${n(x.call_entries, 'call')})${even ? `: that covers the puts, with ${cad(x.calls_collected - x.puts_paid)} over.` : `, leaving ${cad(x.left)}.`}`}
        {!even && x.trading_days_left ? ` Over the ${x.trading_days_left} trading day${x.trading_days_left === 1 ? '' : 's'} left that is ${cad(x.needed_per_day, 2)} a trading day to break even by then.` : ''}
      </span>
      {x.from === 'held' && <span className="review-error">Your Money Hub entries show only {cad(x.puts_in_entries)} of puts, less than the puts you hold cost: some put trades aren’t sorted yet (see the entries below), so the cost of the puts you hold is used.</span>}
      {x.puts_from_held?.length > 0 && <span className="review-error">For {x.puts_from_held.join(', ')} the entries show less in puts than the puts you hold cost, so the held cost is used: some put trades aren’t sorted yet.</span>}
      {x.calls_unknown?.length > 0 && <span className="cc-faint">Calls aren’t known for {x.calls_unknown.join(', ')} (no trade entries), so their puts count in full.</span>}
      {!even && x.call_now_per_day > 0 && x.days_to_even ? (
        <span className="cc-faint">If the next calls pay what the one open now does ({cad(x.call_now_per_day)} a trading day), the rest is covered in {x.days_to_even} trading day{x.days_to_even === 1 ? '' : 's'}, by {day(x.even_on)}{x.in_time === false ? ', after the puts expire' : ''}. The open call’s own premium is already counted above.</span>
      ) : null}
      {!even && !(x.call_now_per_day > 0) && <span className="cc-faint">No call is open now.</span>}
    </div>
  );
}

// The next call (Jake, Nov 17: "advise me on the next call that maximizes my daily return"): his own rule applied to today's
// chain. Of the expiries within his call days, the first strike at least his dollars above the price; most a trading day first.
function NextCall({ p, onLoad, data }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // What was priced before, at today's stock price: asking costs nothing. Pricing it now is his tap (each option price is billed).
  useEffect(() => {
    let live = true;
    send('GET', `/api/options/plan/${p.symbol}?cached=1`).then((x) => live && setPlan(x)).catch(() => live && setPlan(false));
    return () => { live = false; };
  }, [p.symbol, p.price]);
  const priceNow = () => {
    setBusy(true); setErr(null);
    send('GET', `/api/options/plan/${p.symbol}?force=1`).then(setPlan).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  if (plan === false) return null;
  if (!plan) return <div className="cc-next"><span className="cc-k">Next call</span><span className="cc-faint">looking…</span></div>;
  const lots = Math.floor(p.shares / 100);
  const o = data?.options;
  if (plan.needs_pricing) {
    return (
      <div className="cc-next">
        <span className="cc-k">Next call <span className="cc-faint">your rule on today’s prices: which call pays the most a trading day</span></span>
        <div className="cc-row">
          <button type="button" className="small" disabled={busy || !o?.has_token} onClick={priceNow}>{busy ? `Pricing ${p.symbol}’s options…` : `Price ${p.symbol}’s next call`}</button>
          <span className="cc-faint">{o?.has_token ? `about ${plan.plan_cost} of today’s option prices${o.remaining != null ? ` (${o.remaining} left)` : ''}` : 'needs your MarketData.app token (the Data box at the top)'}</span>
        </div>
        {err && <p className="review-error">{err}</p>}
      </div>
    );
  }
  const r = plan.rules;
  const use = (c) => onLoad(p, [...(p.open_legs || []).filter((l) => !(l.type === 'call' && l.side === 'short')),
    { type: 'call', side: 'short', strike: c.strike, expiry: c.expiry, premium: c.bid, contracts: Math.max(1, lots), iv: c.iv, delta: c.delta }]);
  return (
    <div className="cc-next">
      <span className="cc-k">Next call <span className="cc-faint">{plan.call_floor
        ? `by your rule: any strike at or above your ${plan.call_floor} put, expiring within ${r.call_max_days} days; most time value a trading day first (the bid less what the shares give up below ${usd(plan.price, 2)} if called)`
        : `by your rule: at least US$${r.call_otm} above ${usd(plan.price, 2)}, expiring within ${r.call_max_days} days, most a trading day first`}{lots > 1 ? `; for your ${lots} contracts` : ''}</span></span>
      {!lots ? <span className="cc-faint">Under 100 shares: no call can be covered.</span>
        : !plan.call_choices.length ? <span className="cc-faint">{plan.call_floor ? `No call within ${r.call_max_days} days at or above the ${plan.call_floor} put has time value left` : `No call within ${r.call_max_days} days at least US$${r.call_otm} above the price has a bid`} among the options priced {asOf(plan.priced_at)}.</span> : (
          <div className="table-scroll">
            <table className="cc-table cc-nexttable">
              <thead><tr><th>Expires</th><th className="num">Strike</th><th className="num">Bid</th><th className="num" title="The bid less what the shares give up below today's price if called there">Time value</th><th className="num">Trading days</th><th className="num">A trading day</th><th className="num">Premium</th>
                <th className="num" title="The call's delta: roughly the chance the stock ends above the strike">Chance called</th>
                <th className="num" title="What the shares make or lose against your cost if they're called away at the strike">Shares if called</th><th /></tr></thead>
              <tbody>
                {plan.call_choices.map((c, i) => {
                  const called = (c.strike - p.cost) * lots * 100;
                  return (
                    <tr key={`${c.expiry}-${c.strike}`} className={i === 0 ? 'cc-best' : ''}>
                      <td>{short(c.expiry)}{i === 0 && <span className="badge"> MOST A DAY</span>}</td>
                      <td className="num">{c.strike}</td><td className="num">{c.bid.toFixed(2)}{c.modelled ? <span className="cc-faint"> est.</span> : null}</td><td className="num">{(c.time_value ?? c.bid).toFixed(2)}</td><td className="num">{c.days}</td>
                      <td className="num pos">{cad(c.per_day * lots)}</td><td className="num">{cad(c.bid * 100 * lots)}</td>
                      <td className="num">{c.delta == null ? '—' : `≈${Math.round(Math.abs(c.delta) * 100)}%`}</td>
                      <td className={`num ${sign(called)}`}>{signed(called)}</td>
                      <td><button type="button" className="small secondary" onClick={() => use(c)}>Calculator</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      <span className="cc-faint">Your rule applied to {p.symbol} at {usd(plan.price, 2)}, {pricesWords(plan.option_prices)}; not a recommendation: which call to write is your decision.{' '}
        <button type="button" className="small-link" disabled={busy} onClick={priceNow}>{busy ? 'pricing…' : `price again (about ${plan.plan_cost})`}</button></span>
      {err && <p className="review-error">{err}</p>}
    </div>
  );
}

// One stock he holds (or has traded options on): what the shares have done, what the calls and puts have paid, what is open now.
function Holding({ symbol, p, c, entries, money, toUsd, onLoad, reload, reloadCash, ins, rules, data }) {
  const [err, setErr] = useState(null);
  const [showSpreads, setShowSpreads] = useState(false);
  const patch = (body) => send('PATCH', `/api/options/positions/${p.id}`, body).then(reload).catch((e) => setErr(e.message));
  const hasCash = !!c && (c.call_entries > 0 || c.put_entries > 0);
  const calls = hasCash ? toUsd(c.calls) : null; const puts = hasCash ? toUsd(c.puts) : null;
  const optNet = hasCash ? calls + puts : p ? p.premium_collected : 0;
  const f = p?.figures || null;
  const netDay = f ? f.net_after_interest_per_day ?? f.net_per_day : null;
  const live = p && p.status === 'open' && p.price;
  const g = p?.greeks;
  // His strikes on the day's price chart: calls sold, puts held, puts sold, his cost, the breakevens.
  const lines = live ? [
    ...(g?.legs || []).map((l) => ({ price: l.strike, kind: l.type === 'call' ? 'call' : l.side === 'long' ? 'put' : 'sold_put', label: `${l.strike} ${l.type === 'call' ? 'call' : l.side === 'long' ? 'put' : 'put sold'}` })),
    { price: p.cost, kind: 'cost', label: `cost ${Number(p.cost).toFixed(2)}` },
    ...(f?.breakevens || []).map((b) => ({ price: b, kind: 'even', label: `even ${b.toFixed(2)}` })),
  ].filter((l, i, a) => a.findIndex((x) => x.kind === l.kind && x.price === l.price) === i) : [];
  return (
    <div className={`cc-hold cl-hold${p?.signals?.some((s) => s.level === 'high') ? ' flagged' : ''}`}>
      <div className="cc-hold-head">
        <div className="cl-hold-title">
          <span className="cc-sym">{symbol}</span>
          {live && <b className="cl-hold-price"><Num v={p.price} f={(x) => usd(x, 2)} /></b>}
          {live && p.day?.change_pct != null && <span className={`cl-daychip ${sign(p.day.change_pct)}`}>{p.day.change_pct > 0 ? '▲' : p.day.change_pct < 0 ? '▼' : ''} {pctS(p.day.change_pct, 2)} today</span>}
          {p ? <span className="cc-faint">{p.shares} shares · cost {usd(p.cost, 2)}{!live && p.price ? ` · ${usd(p.price, 2)} now` : ''}{p.source === 'broker' ? ' · from your broker' : ''}{p.status === 'planned' ? ' · a plan, not opened' : ''}{live && p.day?.as_of ? ` · ${asOf(p.day.as_of)}` : ''}</span>
            : <span className="cc-faint">no shares on record: option cash only</span>}
        </div>
        <div className="cc-actions">
          {p && <button type="button" className="small" onClick={() => onLoad(p)}>Work out the next call</button>}
          {p && (
            <details className="cc-more"><summary title="More">⋯</summary>
              <div>
                {p.status === 'planned' && <button type="button" className="small-link" onClick={() => patch({ status: 'open' })}>I’ve opened it</button>}
                <button type="button" className="small-link" onClick={() => { const v = window.prompt(`Sold ${p.symbol} at (US$ a share)?`, p.price ?? ''); if (v) patch({ status: 'closed', closed_price: Number(v), legs: [] }); }}>Sold the shares</button>
                <button type="button" className="small-link" onClick={() => window.confirm(`Delete the ${p.symbol} record? Your Money Hub entries stay.`) && send('DELETE', `/api/options/positions/${p.id}`).then(reload)}>Delete this record</button>
              </div>
            </details>
          )}
        </div>
      </div>
      {err && <p className="review-error">{err}</p>}
      {live && <Signals list={p.signals} />}
      {live && (
        <div className="cl-hold-grid">
          <PriceChart bars={p.bars} prev={p.day?.prev_close} lines={lines} symbol={symbol} />
          <div className="cl-hold-side">
            <Tile k="All in" v={<Num v={(p.stock_pnl || 0) + optNet} f={(x) => signed(x)} />} cls={sign((p.stock_pnl || 0) + optNet)} sub="shares and options" />
            <Tile k="Shares" v={<Num v={p.stock_pnl} f={(x) => signed(x)} />} cls={sign(p.stock_pnl)} sub={`worth ${cad((p.price || 0) * p.shares)} · ${signed((p.day?.change || 0) * p.shares)} today`} />
            {hasCash
              ? <Tile k="Options" v={signed(optNet)} cls={sign(optNet)} sub={`calls ${signed(calls)} · puts ${signed(puts)}`} />
              : <Tile k="Options cash" v={signed(optNet)} cls={sign(optNet)} sub="from your positions record" />}
            {netDay != null && <Tile k="Option revenue" v={<>{cad(netDay)} <small>a trading day</small></>} cls={sign(netDay)}
              sub={f.per_day_by_role ? `calls ${cad(f.per_day_by_role.calls)}${f.per_day_by_role.insurance ? ` · insurance ${cad(f.per_day_by_role.insurance)}` : ''}${f.per_day_by_role.income_spreads ? ` · income spreads ${signed(f.per_day_by_role.income_spreads)}` : ''}${f.interest_per_day ? ` · interest −${cad(f.interest_per_day, 2)}` : ''}` : ''} />}
          </div>
        </div>
      )}
      {live && <StrikeMap p={p} />}
      {!live && p && (
        <div className="cc-tiles cc-tiles-sm">
          <Tile k="Shares" v={signed(p.stock_pnl)} cls={sign(p.stock_pnl)} sub={p.price ? `worth ${cad((p.price || 0) * p.shares)}` : 'no price on the stock feed just now'} />
          <Tile k={hasCash ? 'Options' : 'Options cash'} v={signed(optNet)} cls={sign(optNet)} sub={hasCash ? 'calls less puts' : 'from your positions record'} />
        </div>
      )}
      {!p && hasCash && (
        <div className="cc-tiles cc-tiles-sm">
          <Tile k="Calls collected" v={signed(calls)} cls={sign(calls)} sub={`${c.call_entries} entr${c.call_entries === 1 ? 'y' : 'ies'}`} />
          <Tile k="Puts, net" v={signed(puts)} cls={sign(puts)} sub={`${c.put_entries} entr${c.put_entries === 1 ? 'y' : 'ies'}`} />
          <Tile k="Options" v={signed(optNet)} cls={sign(optNet)} sub="calls less puts" />
        </div>
      )}
      {live && g && (
        <div className="cl-block">
          <div className="cc-pick-head">The greeks <span className="cc-faint">{g.legs.length ? (g.iv_assumed ? 'volatility assumed at 50%: no option prices for these yet' : pricesWords(p.option_prices)) : 'shares only'}</span></div>
          <Greeks g={g} rules={rules} shares={p.shares} />
        </div>
      )}
      {live && (
        <div className="cl-block">
          <div className="cc-pick-head">Open now</div>
          <LegLadder p={p} />
          <PutStructure f={f} />
        </div>
      )}
      {live && f?.curve && g?.legs.length > 0 && (
        <div className="cl-block">
          <div className="cc-pick-head">What it makes or loses, by the stock’s price
            <span className="cc-faint">max gain {f.unlimited_gain ? 'no cap' : cad(f.max_gain)} · max loss {f.max_loss == null ? 'no limit' : cad(f.max_loss)}{f.protection_ends ? ` (${cad(f.loss_at_protection_end)} at ${f.protection_ends}, where the spread stops paying)` : f.floor_from ? ` from ${usd(f.floor_from, 2)} down` : ''} · breakeven {f.breakevens?.length ? f.breakevens.map((b) => usd(b, 2)).join(', ') : '—'}</span></div>
          <PayoffChart curve={f.curve} price={p.price} breakevens={f.breakevens} strikes={g.legs.map((l) => l.strike)} horizon={f.horizon} compact />
        </div>
      )}
      {ins && <div className="cc-ins"><span className="cc-k">Put insurance</span><Insurance x={ins} /></div>}
      {p && p.status === 'open' && <NextCall p={p} onLoad={onLoad} data={data} />}
      {live && rules && (
        <details className="cc-trades cl-spread-wrap" open={showSpreads} onToggle={(e) => setShowSpreads(e.currentTarget.open)}>
          <summary>Put spreads on {symbol}: insurance or income</summary>
          {showSpreads && <SpreadBuilder symbol={symbol} position={p} rules={rules} data={data} onLoad={(legs) => onLoad(p, legs)} />}
        </details>
      )}
      {entries.length > 0 && (
        <details className="cc-trades">
          <summary>Trades in Money Hub ({entries.length})</summary>
          <div className="table-scroll">
            <table className="cc-table cc-entries"><tbody>
              {entries.map((e) => <EntryRow key={e.id} e={e} money={money} onSaved={reloadCash} />)}
            </tbody></table>
          </div>
        </details>
      )}
    </div>
  );
}

function Holdings({ positions, cash, ins, rules, data, onLoad, reload, reloadCash }) {
  const [sync, setSync] = useState(null);
  const [showSource, setShowSource] = useState(false);
  useEffect(() => { send('GET', '/api/options/sync').then(setSync).catch(() => {}); }, [positions]);
  if (!positions) return null;
  const toUsd = (n) => (cash?.currency === 'CAD' && getFx() ? n / getFx() : n);
  const money = (n, d = 0) => (cash?.currency === 'CAD' ? plain(n, d) : cad(n, d));
  const live = positions.filter((p) => p.status !== 'closed');
  const closed = positions.filter((p) => p.status === 'closed');
  const cashOf = (s) => cash?.stocks.find((x) => x.symbol === s) || null;
  const entriesOf = (s) => (cash?.entries || []).filter((e) => e.symbol === s && e.kind && e.kind !== 'other');
  const seen = new Set();
  const cards = live.map((p) => { const first = !seen.has(p.symbol); seen.add(p.symbol); return { symbol: p.symbol, p, c: first ? cashOf(p.symbol) : null, entries: first ? entriesOf(p.symbol) : [] }; });
  for (const s of cash?.stocks || []) if (!seen.has(s.symbol) && (s.call_entries || s.put_entries)) cards.push({ symbol: s.symbol, p: null, c: s, entries: entriesOf(s.symbol) });
  const setSource = (body) => send('PUT', '/api/options/cash/source', body).then(reloadCash);
  return (
    <div className="panel cc-panel cc-stocks">
      <div className="panel-header spend-header"><span>Your stocks</span>
        <span className="cc-faint">{sync ? `positions from your broker${sync.account ? ` (${sync.account})` : ''}${sync.by ? ` by ${sync.by}` : ''}: ${new Date(sync.at).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Regina' })}` : 'no positions from your broker yet'}</span></div>
      {!cards.length && <p className="cc-faint cc-pad">Nothing here yet. Your Grok bot sends your broker’s positions with submit_positions, or work out a trade below and save it.</p>}
      <div className="cc-holds">
        {cards.map((x) => <Holding key={x.p ? x.p.id : x.symbol} {...x} money={money} toUsd={toUsd} rules={rules} data={data} onLoad={onLoad} reload={reload} reloadCash={reloadCash}
          ins={x.c || (x.p && !cards.some((y) => y !== x && y.symbol === x.symbol && y.c)) ? ins?.stocks.find((i) => i.symbol === x.symbol) || null : null} />)}
      </div>
      {cash?.unsorted.length > 0 && (
        <div className="cc-pad cc-unsorted">
          <div className="cc-pick-head">{cash.unsorted.length} entr{cash.unsorted.length === 1 ? 'y' : 'ies'} I couldn’t sort: say what {cash.unsorted.length === 1 ? 'it is' : 'they are'}, once</div>
          <div className="table-scroll">
            <table className="cc-table cc-entries"><tbody>
              {cash.unsorted.map((e) => <EntryRow key={e.id} e={e} money={money} onSaved={reloadCash} withWord />)}
            </tbody></table>
          </div>
        </div>
      )}
      {cash && (
        <div className="cc-pad cc-source">
          <span className="cc-faint">
            {cash.read.entries
              ? `Option cash is read from ${cash.read.entries} Money Hub entr${cash.read.entries === 1 ? 'y' : 'ies'}${cash.read.categories.length ? ` under ${cash.read.categories.join(', ')}` : ''}${cash.read.accounts.length ? ` (${cash.read.accounts.join(', ')})` : ''}, in ${cash.currency === 'CAD' ? 'Canadian dollars' : 'US$'}.`
              : 'No brokerage entries found in Money Hub: none are under a category named “Investment”. Pick the account your trades are in.'}
          </span>{' '}
          <button type="button" className="small-link" onClick={() => setShowSource(!showSource)}>{showSource ? 'done' : 'change'}</button>
          {(showSource || !cash.read.entries) && (
            <div className="cc-row">
              <label className="cc-mini">Also read every entry in<select value={cash.account_ids[0] || ''} onChange={(e) => setSource({ account_ids: e.target.value ? [Number(e.target.value)] : [] })}>
                <option value="">no other account</option>{cash.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label className="cc-mini">The amounts are in<select value={cash.currency} onChange={(e) => setSource({ currency: e.target.value })}>
                <option value="USD">US dollars</option><option value="CAD">Canadian dollars</option></select></label>
            </div>
          )}
        </div>
      )}
      {closed.length > 0 && (
        <details className="cc-pad cc-closedlist">
          <summary className="cc-faint">Sold ({closed.length})</summary>
          {closed.map((p) => (
            <div key={p.id} className="cc-row cc-faint">
              <b>{p.symbol}</b> {p.shares} shares, cost {usd(p.cost, 2)}, sold {usd(p.price, 2)}{p.closed_on ? ` on ${day(p.closed_on)}` : ''}: shares <span className={sign(p.stock_pnl)}>{signed(p.stock_pnl)}</span>, options cash {signed(p.premium_collected)}
              <button type="button" className="small-link" onClick={() => window.confirm(`Delete the ${p.symbol} record?`) && send('DELETE', `/api/options/positions/${p.id}`).then(reload)}>×</button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the page
export default function CoveredCalls() {
  const [rules, setRules] = useState(null);
  const [scan, setScan] = useState(null);
  const [scanErr, setScanErr] = useState(null);
  const [selected, setSelected] = useState(null);
  const [positions, setPositions] = useState(null);
  const [cash, setCash] = useState(null);
  const [ins, setIns] = useState(null);
  const [data, setData] = useState(null);
  const [fx, setFxState] = useState(null);
  const [loaded, setLoaded] = useState(null); // a position sent to the calculator (a fresh object each time, so a second tap reloads it)
  // The options he holds at what his fills say they cost (Nov 19), not the broker's lumped average.
  const loadPosition = (p, legs) => { setSelected(p.symbol); setLoaded({ ...p, legs: legs || (p.open_legs?.length ? p.open_legs : p.legs) }); };
  const pickStock = (s) => { if (!s) return; setLoaded(null); setSelected(s); }; // a stock from the list or a note: the rules' pick
  setFx(fx?.rate);
  const loadData = () => send('GET', '/api/options/data').then(setData).catch(() => {});
  const loadScan = () => send('GET', '/api/options/scan').then((s) => { setScan(s); setScanErr(null); if (s.data) setData(s.data); }).catch((e) => setScanErr(e.message));
  const loadPositions = () => send('GET', '/api/options/positions').then((p) => { setPositions(p); loadData(); }).catch(() => setPositions((was) => was || []));
  const loadCash = () => { send('GET', '/api/options/cash').then(setCash).catch(() => setCash(null)); send('GET', '/api/options/insurance').then(setIns).catch(() => setIns(null)); };
  useEffect(() => {
    send('GET', '/api/options/rules').then(setRules);
    send('GET', '/api/options/fx').then(setFxState).catch(() => {});
    loadScan(); loadPositions(); loadCash();
    // Live: his positions each minute, the lists every three (the page is hidden: nothing is asked).
    const tick = (fn) => () => { if (!document.hidden) fn(); };
    const a = setInterval(tick(loadPositions), 60e3);
    const b = setInterval(tick(loadScan), 180e3);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);
  const saveRules = (r) => send('PUT', '/api/options/rules', r).then((x) => { setRules(x); loadScan(); loadPositions(); });
  const tape = useMemo(() => {
    const held = (positions || []).filter((p) => p.status === 'open' && p.price).map((p) => ({ symbol: p.symbol, price: p.price, day_pct: p.day?.change_pct ?? null, held: true }));
    const seen = new Set(held.map((x) => x.symbol));
    const rest = scan ? [...scan.stocks.filter((s) => !s.error), ...(scan.movers || [])].filter((s) => !seen.has(s.symbol) && seen.add(s.symbol)).map((s) => ({ symbol: s.symbol, price: s.price, day_pct: s.day_pct })) : [];
    return [...held, ...rest].slice(0, 26);
  }, [positions, scan]);

  return (
    <div className="cc-page">
      <div className="page-header cl-top">
        <div className="cl-title"><h1 className="page-title">Covered calls</h1>
          <div className="page-meta">{fx?.rate
            ? `Money in Canadian dollars at the Bank of Canada’s ${fx.rate.toFixed(4)} (${short(fx.date)}). Share prices, strikes and premiums a share in US$, as your broker shows them.`
            : 'Exchange rate unavailable: money shown in US$.'} Money Hub never places a trade.</div></div>
        <AlertCenter onPick={pickStock} />
      </div>
      <MarketClock />
      <DataBar data={data} onSaved={(d) => { setData(d); loadPositions(); loadScan(); }} />
      <Tape items={tape} />
      <Earnings positions={positions} cash={cash} ins={ins} />
      <Holdings positions={positions} cash={cash} ins={ins} rules={rules} data={data} onLoad={loadPosition} reload={() => { loadPositions(); loadCash(); }} reloadCash={loadCash} />
      <TodayFive scan={scan} onLoad={(p) => loadPosition(p, p.legs)} />
      {rules && <Watchlist scan={scan} err={scanErr} selected={selected} onPick={pickStock} rules={rules} saveRules={saveRules} />}
      {rules && selected && <Desk symbol={selected} rules={rules} onSaved={loadPositions} loaded={loaded} onClose={() => { setSelected(null); setLoaded(null); }} />}
      {rules && <Rules rules={rules} saveRules={saveRules} />}
    </div>
  );
}
