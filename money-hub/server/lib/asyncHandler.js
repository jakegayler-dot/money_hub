/** Wraps an async Express handler so a thrown/rejected error reaches next(err)
 * instead of becoming an unhandled promise rejection that crashes the process. */
export function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
