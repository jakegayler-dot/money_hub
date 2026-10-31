// A counter that moves on every write to Money Hub's API, so a worked-out result (the Goals plan) can be kept until
// something it depends on changes. Mounted first in index.js, so uploads and agent pushes count too.
let version = 0;
export const dataVersion = () => version;
export const bumpDataVersion = () => { version += 1; };
export function dataVersionTrigger(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') res.on('finish', () => { version += 1; });
  next();
}
