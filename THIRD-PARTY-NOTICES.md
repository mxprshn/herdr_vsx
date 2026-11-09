# Third-party notices

This extension bundles the following. Trademarks belong to their owners; no trademark rights are granted.

| What | Where | From | License |
|---|---|---|---|
| Herdr logo (`media/icon.png`, `media/herdr.svg`), program table (`media/programs.json`), sounds (`media/sounds/`) | `media/` | [herdr-app](https://github.com/herdrdev/herdr-app) | Apache-2.0 |
| Program and agent icons | `media/icons/` | herdr-app, which takes them from Simple Icons (CC0 1.0), Lucide (ISC/MIT) and LobeHub icons (MIT) | see [`media/icons/LICENSES.md`](media/icons/LICENSES.md) and the license files next to it |
| qrcode-generator | `media/vendor/qrcode.js` | [kazuhikoarase/qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | MIT (header in the file) |
| Codicons | `media/codicons/` | [microsoft/vscode-codicons](https://github.com/microsoft/vscode-codicons) | CC-BY-4.0 (font), MIT (code); see [`media/codicons/LICENSE`](media/codicons/LICENSE) |

The herdr-core protocol handling in `src/core.ts` and `src/state.ts`, and the program matching in `src/programs.ts`, follow herdr-app's `src/hc.rs` and `src/programs.rs` (Apache-2.0).
