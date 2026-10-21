# vendor/

Prebuilt single-file copies of the libraries the app uses, so the app needs no build step and no node_modules in OneDrive. Built once on 2026-10-20 with esbuild (in a temp folder outside OneDrive).

| File | Contents |
|---|---|
| editor.js | CodeMirror 6 (view 6.43.15, state 6.7.6, language 6.13.1, commands 6.11.1, lang-markdown 6.5.2, @lezer/highlight 1.2.5) |
| msal.js | @azure/msal-browser 5.22.0 (Microsoft sign-in) |
| export.js | docx 9.13.0, jszip 3.10.2, marked 18.1.1 (used by export, stage 3) |

To rebuild: `npm install` those exact versions plus esbuild in a scratch folder, write an entry file that re-exports the names the app imports (see the `import` lines at the top of `js/editor.js`, `js/auth.js`, `js/export.js`), and run
`esbuild entry.js --bundle --format=esm --minify --target=es2020 --legal-comments=eof --outfile=<this folder>/<name>.js`.
