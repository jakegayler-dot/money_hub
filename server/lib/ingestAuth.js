// Shared guard for every endpoint an outside system pushes data into
// (contracts, inventory, estimates). One key, INGEST_API_KEY, set as a
// server environment variable and sent in the X-Api-Key header. Ingest is
// refused entirely until the variable is set — an open write endpoint on a
// public URL is not a default anyone should get silently.
export function requireIngestKey(req, res, next) {
  const configuredKey = process.env.INGEST_API_KEY;
  if (!configuredKey) {
    return res.status(503).json({ error: 'Ingest is not enabled: set the INGEST_API_KEY environment variable on the server first.' });
  }
  if (req.get('x-api-key') !== configuredKey) {
    return res.status(401).json({ error: 'Invalid or missing X-Api-Key header.' });
  }
  next();
}
