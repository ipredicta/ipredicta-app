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
