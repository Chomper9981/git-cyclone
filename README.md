<p align="center">
  <img src="logo/git-cyclone-logo.svg" width="96" height="96" alt="Git Cyclone logo">
</p>

<h1 align="center">Git Cyclone</h1>

<p align="center">A desktop app for managing all the Git repositories on your computer.</p>

Git Cyclone runs the `git` already installed on your machine, so hooks, LFS and Git Credential Manager
behave exactly as they do in the terminal. It works offline; the only network traffic is git itself.

## Features

- **Workspace** — scan a folder (for example `D:\Projects`) and see every repository at a glance:
  branch, ahead/behind, staged/modified/new files, stashes, last commit. Filter, pin, group, and
  fetch all repositories at once.
- **History** — commit graph with branches, merges and tags; commit details with per-file diffs;
  blame and file history.
- **Changes** — stage or unstage whole files, single hunks, or **individual lines**; discard with an
  automatic backup; commit, amend, or commit & push.
- **Branches, tags, stashes** — create, rename, delete, check out, merge, rebase, cherry-pick, revert,
  reset (a hard reset stashes your changes first).
- **Conflicts** — resolve block by block (current / incoming / both / base) or edit by hand.
- **Remotes** — fetch, pull (fast-forward only by default), push, publish new branches; force push
  always uses `--force-with-lease`.
- **Git & accounts** — manage the git setup you already have, shared with the terminal and VS Code:
  - commit identity, plus per-folder identities (for example a work email for everything in `D:\Work`);
  - GitHub accounts stored by Git Credential Manager: sign in, sign out, clean up broken entries,
    and choose which account each repository pushes with;
  - SSH keys: list, create, copy the public key, test the connection to GitHub.

  Git Cyclone never stores passwords or tokens itself.
- **System tray** — choose whether closing the window minimizes to the tray or quits.
- **Languages** — English (default) and Vietnamese.

## Requirements

- **Windows 10/11** — [Git for Windows](https://git-scm.com/download/win) in `PATH`
  (WebView2 is included in Windows 11).
- **Linux** — `git` in `PATH` and WebKitGTK 4.1 (installed automatically by the `.deb` / `.rpm`).
  Optional: [Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager/blob/release/docs/install.md)
  for GitHub accounts over HTTPS. The tray icon needs a desktop that shows tray icons (KDE, XFCE,
  or GNOME with the AppIndicator extension); elsewhere the window minimizes instead.

## Building from source

Prerequisites: Node.js 22.12+ (or 20.19+) and Rust stable (MSVC toolchain on Windows). On Debian/Ubuntu also:

```bash
sudo apt install build-essential curl wget file git libwebkit2gtk-4.1-dev libssl-dev   libxdo-dev libayatana-appindicator3-dev librsvg2-dev
```

Then:

```bash
cd app
npm install
npm run tauri dev      # run in development
npm run tauri build    # installers in app/src-tauri/target/release/bundle/
```

The build produces the installers for the system it runs on: `nsis` and `msi` on Windows;
`deb`, `rpm` and `appimage` on Linux. Pushing a `v*` tag runs the release workflow, which builds
both and attaches them to a draft GitHub release.

Run the tests:

```bash
cd app/src-tauri
cargo test
```

## Accounts

Pushing and pulling use the credentials git already has: **Git Credential Manager** (included with
Git for Windows, a separate install on Linux) for HTTPS remotes and your **SSH keys** for SSH remotes. If `git push` works in your
terminal, it works in Git Cyclone. Use **Git & accounts** (button at the top right) to sign in with
Git Credential Manager, pick an account per repository, or create an SSH key.

## Project layout

```
app/              Tauri 2 (Rust) + React 19 + TypeScript
  src/            user interface
  src-tauri/src/  git engine, git environment (identity, GCM, SSH), tray
logo/             application logo
```

## License

[MIT](LICENSE)
