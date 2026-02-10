# biblib-cli

CLI for retrieving bibliographic metadata through Zotero Translation Server and writing CSL-JSON metadata into Markdown YAML frontmatter.

## Features

- Resolve DOI/ISBN/PMID/arXiv identifiers and URLs through Translation Server
- Convert translator output to CSL-JSON
- Write/merge frontmatter into Markdown files
- Optional built-in Translation Server management via Node process
- Config at `~/.config/biblib/config.yaml`

## Install

```bash
npm install
npm run build
npm link
```

## Translation Server Setup (No Docker)

Clone and install translation-server once:

```bash
git clone https://github.com/zotero/translation-server.git ~/projects/translation-server
cd ~/projects/translation-server
npm install
```

## Quickstart

1. Initialize config:

```bash
biblib init-config
```

2. Set `serverManagement.sourcePath` in `~/.config/biblib/config.yaml` if needed.

3. Start Translation Server from source:

```bash
biblib server start
```

4. Fetch metadata:

```bash
biblib fetch "10.1038/s41586-020-2649-2" --format json
```

5. Write frontmatter into a note:

```bash
biblib write "10.1038/s41586-020-2649-2" notes/example.md --ensure-server
```

## Commands

- `biblib init-config [--force]`
- `biblib fetch <query> [--format json|yaml|frontmatter] [--output path] [--server-url url] [--ensure-server]`
- `biblib write <query> [markdown-file] [--replace] [--dry-run] [--attachments|--skip-attachments] [--server-url url] [--ensure-server]`
- `biblib from-json <json-file> <markdown-file> [--replace] [--dry-run]`
- `biblib server status [--server-url url]`
- `biblib server start [--server-url url]`
- `biblib server stop`

## Config

Default path: `~/.config/biblib/config.yaml`.

```yaml
rootFolderPath: /home/youruser/notes
translationServerUrl: http://127.0.0.1:1969
requestTimeoutMs: 20000
literatureNoteTag: literature_note
literatureNotePath: .
attachmentFolderPath: attachments
filenameTemplate: "@{{citekey}}"
customFrontmatterFields:
  - name: year
    template: "{{year}}"
    enabled: true
citekey:
  template: "{{author_family}}{{year}}"
  minLength: 6
  randomDigits: 4
write:
  mergeStrategy: shallow
  preserveFields:
    - tags
attachments:
  enabled: false
  maxFiles: 3
  pdfOnly: true
  createSubfolderByCitekey: true
  timeoutMs: 30000
serverManagement:
  enabled: true
  autoStart: true
  sourcePath: /home/youruser/projects/translation-server
  nodeCommand: node
  pidFile: /home/youruser/.cache/biblib/translation-server.pid
  logFile: /home/youruser/.cache/biblib/translation-server.log
  startupTimeoutMs: 20000
  pollIntervalMs: 500
```

Set `serverManagement.enabled: true` and `serverManagement.autoStart: true` if you want `fetch` and `write` to auto-start the local source server when unreachable.
All note and attachment paths are resolved relative to `rootFolderPath` unless you pass an absolute path.
