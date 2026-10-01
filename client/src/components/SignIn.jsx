import { useState } from 'react';

// Shown instead of the app until the shared password is entered.
export default function SignIn({ onSignedIn }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    }).catch(() => null);
    setBusy(false);
    if (r && r.ok) { setPassword(''); onSignedIn(); return; }
    const body = r ? await r.json().catch(() => ({})) : {};
    setError(body.error || 'Could not reach Money Hub.');
  };

  return (
    <div className="signin-wrap">
      <form className="signin" onSubmit={submit}>
        <div className="brand-mark">Money Hub</div>
        <div className="field">
          <label htmlFor="mh-password">Password</label>
          <input id="mh-password" type="password" autoComplete="current-password" autoFocus required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="review-error" style={{ margin: 0 }}>{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="signin-note">Stays signed in on this device for 30 days.</p>
      </form>
    </div>
  );
}
