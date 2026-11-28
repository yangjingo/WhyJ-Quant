# WhyJ Quant Desktop 1.5.0

This Windows x64 release brings the shared research Workbench into Desktop, adds connection checks in Settings, and introduces an online installer alongside the complete offline installer.

## Highlights

- **Open the shared Workbench in Desktop.** Desktop connects to the local Host used by the browser and terminal. Closing the window to the tray preserves the active run, and reopening the Workbench can reconnect to it. [Shared Host integration](https://github.com/yangjingo/WhyJ-Quant/pull/149)
- **Verify connections before saving.** Model settings can check the selected provider and model. Market Data settings can test the selected source with a sample before saving it. [Model settings](https://github.com/yangjingo/WhyJ-Quant/pull/303) · [Data-source settings](https://github.com/yangjingo/WhyJ-Quant/pull/297)
- **Choose the installer for your environment.** The online installer downloads and verifies the complete versioned Windows installer before starting installation. The complete installer can be downloaded separately for offline installation. [Online installer](https://github.com/yangjingo/WhyJ-Quant/pull/96)

## What's Changed

- Stock lists can show fixed daily candles and dated auction curves. Same-day stock and ETF intraday views retain their provisional status. [Daily candles](https://github.com/yangjingo/WhyJ-Quant/pull/984) · [Auction chart](https://github.com/yangjingo/WhyJ-Quant/pull/998) · [Stock intraday](https://github.com/yangjingo/WhyJ-Quant/pull/994) · [ETF intraday](https://github.com/yangjingo/WhyJ-Quant/pull/996)
- The installed package includes the shared React assets and the Host runtimes. The Workbench no longer requires a separately started Web development server. [React packaging](https://github.com/yangjingo/WhyJ-Quant/pull/247)

## Installation and Upgrade

Choose `WhyJ-Quant-Setup-1.5.0-win-x64.exe` or `WhyJ-Quant-Online-1.5.0-win-x64.exe` from the Release assets and compare its SHA-256 with `SHA256SUMS.txt`. The online entry requires network access to fetch the complete installer. Use the complete installer to install without that download.

The installer uses the existing per-user application identity and keeps the selected installation directory on reinstall. Settings, sessions, and reports are stored separately from the application files. [Windows installer checks](https://github.com/yangjingo/WhyJ-Quant/blob/main/apps/desktop/scripts/test-install.ps1)

## Known Limitations

- The installers are unsigned. Windows can display an unknown-publisher warning, and application-control policies can block installation or startup.
- Model and market-data calls require network access and any credentials required by the selected provider. A successful connection sample covers the selected provider operation.
- Installer automation covers a clean install and same-version reinstall. Cross-version and interactive acceptance depend on checks against the exact Windows candidate.

## Verification

Publication requires a successful main-branch CI run and installed-app acceptance of the exact Windows candidate. The publication workflow appends the candidate's Actions run to these notes. [Release and verification procedure](https://github.com/yangjingo/WhyJ-Quant/blob/main/docs/ci-release.md#desktop-release-and-website-handoff)

## Full Changelog

[v1.4.0...v1.5.0](https://github.com/yangjingo/WhyJ-Quant/compare/v1.4.0...v1.5.0)
