# SaveRelay

Automatic game save sharing between trusted friends. Anyone can continue a shared world, and the others get the update automatically when they're back online. Launch games the way you always do (Steam, Ubisoft Connect, shortcuts). SaveRelay runs in the tray.

It implements the first testable slice of the *PRD — Automatic Game Save Sharing* (Notion). Stack: Svelte 5 + TypeScript + Electron.

## Install (Windows)

1. Open the [latest release](https://github.com/kmasouri/saverelay/releases/latest).
2. Download `SaveRelay-Setup-<version>.exe` and run it. It installs per-user, so no admin prompt.
3. The build is unsigned, so Windows SmartScreen will warn you. Choose **More info → Run anyway**.

### Updates

Like Discord, SaveRelay checks for updates in the background every few hours. It downloads only what changed (differential NSIS update), and switches to the new version the next time it restarts. Settings and the tray menu show a **Restart to update** button once an update is ready.

Updates come from this repo's GitHub Releases, so installs need no GitHub login.

### Shipping a new version

```sh
npm version patch        # bumps package.json and creates the tag
git push --follow-tags   # Release workflow: build, smoke test, publish the update
```

## Using it

1. **Friends:** each person copies their invite code (Friends page) and pastes everyone else's. Trust is explicit and pairwise.
2. **Share a world:** pick a detected Anno 1800 world, or browse to any save folder. Confirm the exact folder and tick the friends who get it.
3. **Join:** friends see an invitation, choose their *own* local save folder, and join. Their existing saves are backed up first.
4. **Play normally.** While the game runs, nothing touches its save folder. After it exits and the files settle, changed saves are published. Incoming saves apply when the game is closed.

Conflicts (two people continued independently) follow the group's policy:

- **Preserve both and ask** (default)
- **Latest modified wins**, by original save time
- **Preferred device**

Nothing is ever merged or deleted. Every version stays in **History** with its contributors and can be restored.

## How it works

```
src/core/      game-independent model: manifests, signed events, history, reconcile policy
src/main/      Electron main process + engine (scanner, staging store, journaled applier,
               process detection, Syncthing transport, auto-updater)
src/preload/   narrow IPC bridge (one invoke channel + state stream)
src/renderer/  Svelte UI
```

- **Snapshots** are content-addressed: each file is stored by SHA-256, and a snapshot's *content id* hashes the sorted relative paths, sizes and hashes. Timestamps, contributors and local paths are excluded, so identical saves group across friends.
- **Events** (`capture`, `restore`, `applied`, `decision`, `policy`) are immutable JSON. Each device signs its events with an Ed25519 key and writes only into its own directory of the world's staging store. Events from devices you haven't added, or with bad signatures, are ignored.
- **History** (who captured what, where it's available) is computed separately from the **policy layer**, which uses ancestry to decide the accepted continuation. Descendants win automatically, older ancestors never roll anything back, and independent branches go to the group policy. Decisions are recorded as events, so every peer converges and rejected branches don't come back.
- **Transport** is a bundled, private [Syncthing](https://syncthing.net) instance (authenticated TLS, NAT traversal, relays). It only syncs the app's staging store, never your live save folder. Folder offers are never auto-accepted.
- **Applying** an update verifies every hash, backs up the live files, writes through a journal, and preserves original modification times. A crash mid-apply is rolled back on next start.

Data lives in `%APPDATA%\SaveRelay\`: `config.json`, `staging\`, `backups\`, `logs\`.

## Development

```sh
npm install
npm run fetch:syncthing   # Syncthing binary for this OS/arch into resources/syncthing/
npm run dev               # Electron with hot reload
npm test                  # unit + 3-device engine simulation (+ real Syncthing test if SYNCTHING_BIN is set)
npm run typecheck
```

Windows installers are built by GitHub Actions (`.github/workflows/release.yml`) on `windows-latest`. The dev box is Linux/ARM, and Windows packaging there isn't practical.

## Known limitations (prototype)

- **Anno 1800:** the process names (`Anno1800.exe`) and folder layout are unvalidated assumptions. Whether multiplayer participants produce byte-identical saves is unknown. If they don't, a three-player session shows up as competing versions, and the policy decides. Run the PRD's disposable-world test before using real saves.
- **Launch race:** if you start the game before a pending update applies, the update waits until you quit. You get a notification when this happens.
- **Delivery:** updates are peer-to-peer only. A friend who holds the update must be online at the same time as you.
- **Revocation:** removing a friend stops future sharing. Files they already received can't be recalled.
- **Platforms:** only Windows builds are produced for now. macOS and Linux targets are configured but unvalidated.
