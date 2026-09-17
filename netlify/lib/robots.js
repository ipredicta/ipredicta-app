'use strict';
/* _robots.js — every function response carries X-Robots-Tag: noindex.
 *
 * WHY A WRAPPER AND NOT A LINE IN EACH `return`. Google was crawling
 * app.ipredicta.co/.netlify/functions/telegram-disconnect (GSC, 17 September 2026). Netlify's
 * [[headers]] in netlify.toml apply to STATIC ASSETS ONLY — a function's response headers come
 * from the object its handler returns — so this has to be set in code.
 *
 * The six handlers hold about 35 `return` statements between them, most of them early error
 * exits. Adding the header to each is 35 chances to miss one, and a miss is invisible: the
 * function works, the response is correct, and only a crawler ever sees the difference. Wrapping
 * the exported handler covers every path, including every path added after today.
 *
 * It never changes status, body or any other header, and it tolerates a handler returning
 * something odd rather than throwing on it: an analytics-shaped concern must not break the
 * endpoint it annotates.
 */
function noindex(handler) {
  return async function (event, context) {
    const res = await handler(event, context);
    if (!res || typeof res !== 'object') return res;
    return Object.assign({}, res, {
      headers: Object.assign({}, res.headers || {}, { 'X-Robots-Tag': 'noindex, nofollow' }),
    });
  };
}
module.exports = { noindex };

/* WHY THIS LIVES IN netlify/lib AND NOT netlify/functions.
 * Netlify deploys EVERY .js file at the top level of the functions directory as a function,
 * including helpers that export no handler. Measured on the preview before this move: with a
 * non-existent name as the control returning 404, /.netlify/functions/_robots and
 * /.netlify/functions/_crypto both returned 502 — deployed, callable, and crashing on
 * invocation. An underscore prefix is a naming convention and means nothing to the bundler.
 *
 * On the same day, the MAIN SITE's production deploy failed outright with "serverless functions
 * failed to deploy: subscribe.test" for exactly this reason: a test file sitting at the top
 * level of netlify/functions. A helper only wasted a slot and served a 502; a test file took the
 * whole deploy down and blocked every change behind it for hours. Same mistake, two blast radii.
 *
 * A file under netlify/functions is a PUBLIC HTTP ENDPOINT. Anything that is not one belongs
 * outside that directory. */
