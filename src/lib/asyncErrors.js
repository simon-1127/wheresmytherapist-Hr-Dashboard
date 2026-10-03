// Express 4 does not catch rejected promises from async route handlers.
// Before this patch, any `await` that threw (a Supabase network blip, a bad
// uuid reaching Postgres, a typo'd column) left the request hanging until
// the browser gave up, and surfaced only as an "unhandled rejection" line
// in the Railway logs. This forwards those rejections to the normal error
// handler, so the user sees the 500 page with the actual message instead.
//
// Same technique as the `express-async-errors` package, inlined so there is
// no extra dependency. Must be required BEFORE any router is created.
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__wmtAsyncPatched) {
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // error-handling middleware, same as stock Express
    try {
      const ret = fn(req, res, next);
      if (ret && typeof ret.catch === 'function') ret.catch(next);
    } catch (err) {
      next(err);
    }
    return undefined;
  };
  Layer.prototype.__wmtAsyncPatched = true;
}
