# Contributing

SaveRelay is in the public domain (see `LICENSE`). By sending a change, you agree to release it the same way.

## Adding a game

SaveRelay finds saves on its own for every game listed in [`games/`](games). Each game is one small JSON file, with no code. Anyone can add one with a pull request.

### 1. Find out three things about the game

- **Where it saves.** Look up the game on [PCGamingWiki](https://www.pcgamingwiki.com) under *Save game data location*, then check that folder on your PC. You want the folder that holds **one game's** saves: one world, one profile or one multiplayer session. That's what friends share.
- **Which files are the save.** Usually something like `*.sav`. Leave out files that belong to one player only, like settings or account data.
- **The program name.** Start the game, open Task Manager, go to the **Details** tab and note the `.exe` name. SaveRelay uses it to know when you're playing, so it never touches saves while the game is running.

Before writing the file, you can try it in SaveRelay with **Other game…**, picking the folder and the `.exe` yourself.

### 2. Write `games/<game-name>.json`

The file name is the game's id: lowercase words joined by dashes, like `anno-1800.json`. Copy this and fill it in:

```json
{
  "$schema": "./schema.json",
  "name": "Some Game",
  "windows": {
    "saves": "{savedgames}/Some Game/Worlds/*",
    "contains": "*.sav",
    "exe": ["SomeGame.exe"]
  },
  "include": ["*.sav"],
  "exclude": [],
  "notes": "One folder per world.",
  "example": {
    "files": ["{savedgames}/Some Game/Worlds/My World/world.sav"],
    "finds": ["My World"]
  }
}
```

| Field | What it means |
| --- | --- |
| `name` | The game's name as players know it. |
| `windows.saves` | Where the save folders are. It must start with a placeholder, and each `*` matches one folder level. Each folder this matches is one save in SaveRelay. |
| `windows.contains` | A save folder must directly contain a file like this, so empty or unrelated folders are skipped. |
| `windows.exe` | Program names from Task Manager's Details tab. List every version, e.g. a DX12 build. |
| `include` / `exclude` | Which files inside a save folder get synced. |
| `stripPrefix` | Optional. Text to drop from folder names when shown, e.g. `MP-`. |
| `example` | Optional, but please add it. Sample files, and the save names SaveRelay should find among them. The tests create these files and check. |

**Placeholders** for `windows.saves`. These are the only places a path can start:

| Placeholder | Usually |
| --- | --- |
| `{documents}` | `C:\Users\<you>\Documents`, or wherever Documents was moved, e.g. OneDrive |
| `{savedgames}` | `C:\Users\<you>\Saved Games` |
| `{appdata}` | `C:\Users\<you>\AppData\Roaming` |
| `{localappdata}` | `C:\Users\<you>\AppData\Local` |
| `{localappdatalow}` | `C:\Users\<you>\AppData\LocalLow` |
| `{home}` | `C:\Users\<you>` |

Paths can't use `..`, drive letters or `\`. That keeps a game file from pointing SaveRelay at anything outside those folders.

### 3. Check it and send it

```sh
npm ci
npm test
```

The tests check every game file: the format, the path rules, that names are unique, and that your `example` is really found. They run again automatically on your pull request, and the error messages say what to fix.

## Code changes

```sh
npm ci
npm run typecheck
npm test
npm run dev      # runs the app
```

Windows installers are only built by GitHub Actions (see `README.md`).
