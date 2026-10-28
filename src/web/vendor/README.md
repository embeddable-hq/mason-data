# Third-party files the web page vendors

Mason runs on machines without internet, so the page loads nothing from elsewhere: each dependency below is copied
here WHOLE (its built file(s) and its licence), pinned to an exact version, and served by Mason from its allowlist
(`PAGE_ROUTES`, src/cli/run-server.ts). None is fetched at run time, and none is changed. Mason itself is Apache-2.0
(the root `LICENSE`); these files keep their own licences.

| Folder | Package | Version | Licence | Files | Size |
|---|---|---|---|---|---|
| `geist-1.7.2/` | [`geist`](https://www.npmjs.com/package/geist) (Geist Sans and Geist Mono, by Vercel with basement.studio) | 1.7.2 | SIL Open Font License 1.1 (`LICENSE.txt`) | `Geist-Variable.woff2`, `GeistMono-Variable.woff2` (the variable fonts, `dist/fonts/geist-sans/` and `dist/fonts/geist-mono/`) | 68 KiB, 70 KiB |
| `uplot-1.6.32/` | [`uplot`](https://www.npmjs.com/package/uplot) (by Leon Sorokin) | 1.6.32 | MIT (`LICENSE.txt`, the package's `LICENSE`) | `uPlot.esm.js`, `uPlot.min.css` (`dist/`) | 142 KiB, 2 KiB |

About 282 KiB in all, served only when the page asks for them (the fonts by app.css's `@font-face`, uPlot by
src/web/charts.js once a chart is drawn).

## Updating one

1. `npm pack <package>@<exact version>` in a temporary folder; unpack it.
2. Copy only the files above and the licence into a NEW folder named `<package>-<version>/`; delete the old one and the tarball.
3. Change the routes in `PAGE_ROUTES`, the paths in app.css / charts.js / index.html, and this table.
4. `npm run check`: tests/web-page.test.ts holds every file here to a route and a licence beside it.
