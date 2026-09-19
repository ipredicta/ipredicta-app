# Working in ipredicta-app

Short, and only things that cost someone time before they could have known.

## Run `npm install` before any CLI deploy from a fresh worktree

`node_modules/` is gitignored, so a worktree cut from `origin/main` has none, and the
failure does not look like a missing dependency. `netlify deploy` gets as far as Functions
bundling and then fails **all six functions** with:

```
✘ [ERROR] Could not resolve "@supabase/supabase-js"
  netlify/functions/telegram-link-code.js:3:33
Dependencies installation error
```

followed by `Error: Error while running build`. Nothing is published. The deploy is not
broken and neither is the code: `@supabase/supabase-js` is the repo's one dependency and it
simply is not on disk.

```
npm install          # from the repo root, before `netlify deploy`
```

This is the same class of trap as the site repo's rule about installing at the repository
root as well as inside `ipredicta 3`, and it has the same cause: **the function bundler
resolves from the directory it runs in, not from wherever you happen to have a populated
`node_modules`.** Cost one failed deploy on 2026-09-19.

Note this repo tracks **no lockfile**, so `npm ci` will refuse and `npm install` writes a
`package-lock.json` that should be left untracked.

## A merge to main is a deploy, immediately

`netlify.toml` declares `publish = "public"` and **no build command**. There is no CI, no
promotion step and no deploy-verify. A push to main that breaks `public/index.html` is a
broken members area for every signed-in member within seconds, and the first signal is a
member complaining. Treat every change as production, because it is.

This is the opposite of ipredicta-site, where Netlify builds a separate `production` branch
and a push to main ships nothing until a promotion runs. Do not carry that habit across.

## The web root is `public/`, not the repository root

It was `publish = "."` until 2026-09-17, which served `/package.json` and every file under
`/netlify/functions/` as readable source. Anything a browser must fetch goes in `public/`;
anything else must stay out of it. Adding a file to the repo root does not publish it, and
that is the right way round.

## GA4 and consent are one file, and it is load-bearing

`public/assets/consent.js` is the only thing that loads GA4. Adding a `gtag` snippet to a
page would set analytics cookies before a member had agreed and would silently falsify the
privacy policy. It is also loaded **without `defer`** and must stay above the inline script
block in `index.html`: that block runs at parse time and calls `window.iPredictaConsent`.
