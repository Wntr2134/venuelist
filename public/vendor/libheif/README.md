# libheif (vendored)

HEIC/HEIF photo decoder, used only in the browser and only when the browser can't open a
HEIC photo itself (Chrome, Firefox, Android, Windows). Safari on iPhone, iPad and Mac opens
HEIC natively and never loads this.

- Source: npm `libheif-js` 1.23.5 (https://github.com/catdad-experiments/libheif-js), the
  `libheif-wasm/` build: `libheif.js` + `libheif.wasm`, unmodified.
- Licence: LGPL-3.0 (see `LICENSE`). It's served as separate, unmodified files, so anyone can
  replace them with their own build of libheif.
- Loaded on demand by `decodeHeic()` in `public/js/common.js`, which fetches `libheif.wasm` itself
  and passes it in as `wasmBinary` (libheif's own loader fails in the browser here). Needs
  `'wasm-unsafe-eval'` in the CSP `script-src` (set in `src/app.js`).
- To update: `npm pack libheif-js@<version>`, copy `libheif-wasm/libheif.js`, `libheif.wasm`
  and `LICENSE` here, then check a HEIC photo still converts in Chrome.
