# OpenSpec for Herdr

A read-only [OpenSpec](https://github.com/Fission-AI/OpenSpec) browser for the [Herdr](https://herdr.dev) desktop app. It shows the changes and specs of the repo your focused terminal is in, on this machine or any machine Herdr reaches.

## Features

- **Follows the focused terminal.** Switch terminals and it switches repos. Each repo remembers where you were.
- **Active, Specs, Archived** tabs. Active changes show task progress.
- **Structured documents.** Tasks are shown as foldable groups with progress, and specs as requirements with their scenarios. Proposals and designs are shown as markdown. A change's spec deltas are listed in one Specs dropdown.
- **Sections.** Pick one heading to read it on its own.
- **Mermaid diagrams.** Mermaid blocks are drawn as images rather than shown as code. Any diagram type mermaid supports works. Click a diagram to open it full size. See [Dependencies](#dependencies).
- **Full screen.** The button in the corner (or the `openspec:expand` command) opens it near full screen, keeping the same change and document. Esc or the button again closes it.
- **Works on remote machines.** One `sh` script reads the folder. The remote machine only needs `sh`, `git` and `awk`, not the openspec CLI.

## Keys

| Key | Does |
| --- | --- |
| type (in the filter) | filter entries |
| ↑ ↓ | previous / next entry |
| ← → | previous / next document |
| shift+← → | Active / Specs / Archived |

## Dependencies

| What | Where | Why |
| --- | --- | --- |
| Herdr desktop app | this machine | runs the mod |
| `sh`, `git`, `awk` | the machine the repo is on | scanning `openspec/` |
| [mermaid-cli](https://github.com/mermaid-js/mermaid-cli) (`mmdc`) | this machine | drawing mermaid diagrams (optional) |

Diagrams are rendered on the machine running Herdr, even for repos on remote machines, because the mod already has each document's text.

```sh
# With Google Chrome installed (macOS): skip puppeteer's Chromium download.
# puppeteer.json points mmdc at Chrome.
PUPPETEER_SKIP_DOWNLOAD=1 npm i -g @mermaid-js/mermaid-cli

# Without Chrome: let puppeteer download its own Chromium.
npm i -g @mermaid-js/mermaid-cli
```

Without `mmdc`, each diagram is shown as its source along with the install command. The mod also looks for `mmdc` in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.npm-global/bin`.

Each diagram is rendered once, to `.cache/<hash>.png` in this folder. The hash covers the diagram's source and the light or dark theme. Delete `.cache/` to render them all again.

## Install

Copy this folder to `~/.config/herdr-app/mods/openspec` and add it to a layout, for example as a side-panel tab:

```json
{ "id": "openspec", "mod": "openspec" }
```

## Files

| File | |
| --- | --- |
| `main.js` | the view |
| `data.js` | the scan script and the parsers for tasks, specs and sections |
| `mermaid.js` | finding mermaid blocks and rendering them with `mmdc` |
| `puppeteer.json` | points `mmdc` at Google Chrome |
