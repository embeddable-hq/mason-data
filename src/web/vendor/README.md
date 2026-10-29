# Third-party files the web page vendors

Mason runs on machines without internet, so the page loads nothing from elsewhere: each dependency below is copied
here WHOLE (its built file(s) and its licence), pinned to an exact version, and served by Mason from its allowlist
(`PAGE_ROUTES`, src/cli/run-server.ts). None is fetched at run time, and none is changed. Mason itself is Apache-2.0
(the root `LICENSE`); these files keep their own licences.

| Folder | Package | Version | Licence | Files | Size |
|---|---|---|---|---|---|
| `geist-1.7.2/` | [`geist`](https://www.npmjs.com/package/geist) (Geist Sans and Geist Mono, by Vercel with basement.studio) | 1.7.2 | SIL Open Font License 1.1 (`LICENSE.txt`) | `Geist-Variable.woff2`, `GeistMono-Variable.woff2` (the variable fonts, `dist/fonts/geist-sans/` and `dist/fonts/geist-mono/`) | 68 KiB, 70 KiB |
| `zilla-slab-5.3.0/` | [`@fontsource/zilla-slab`](https://www.npmjs.com/package/@fontsource/zilla-slab) (Zilla Slab, by Typotheque for the Mozilla Foundation) | 5.3.0 | SIL Open Font License 1.1 (`LICENSE.txt`, the package's `LICENSE`) | `zilla-slab-latin-700-normal.woff2` (`files/`: the bold, Latin only — the titles and the big numbers) | 26 KiB |
| `lucide-1.56.0/` | [`lucide-static`](https://www.npmjs.com/package/lucide-static) (Lucide's icons, by Lucide Icons and contributors) | 1.56.0 | ISC (`LICENSE.txt`, the package's `LICENSE`) | `layout-dashboard.mjs`, `table.mjs`, `users.mjs`, `square-terminal.mjs`, `chart-column.mjs`, `logs.mjs`, `menu.mjs`, `x.mjs` (`dist/esm/icons/`: each exports its 24-unit SVG as a string; the sidebar's nav and the phone's menu button) | 5 KiB in all |
| `uplot-1.6.32/` | [`uplot`](https://www.npmjs.com/package/uplot) (by Leon Sorokin) | 1.6.32 | MIT (`LICENSE.txt`, the package's `LICENSE`) | `uPlot.esm.js`, `uPlot.min.css` (`dist/`) | 142 KiB, 2 KiB |

About 313 KiB in all, served only when the page asks for them (the fonts by app.css's `@font-face`, uPlot by
src/web/charts.js once a chart is drawn, the icons by src/web/shared.js's imports). Only the icons the page draws are
copied, each module whole; its source map (`//# sourceMappingURL`) is not, so a browser's developer tools may ask for it
and get a 404.

## Updating one

1. `npm pack <package>@<exact version>` in a temporary folder; unpack it.
2. Copy only the files above and the licence into a NEW folder named `<package>-<version>/`; delete the old one and the tarball.
3. Change the routes in `PAGE_ROUTES`, the paths in app.css / charts.js / index.html, and this table.
4. `npm run check`: tests/web-page.test.ts holds every file here to a route and a licence beside it.
