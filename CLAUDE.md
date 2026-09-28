# Claude-Mem: AI Development Instructions

This repository is **claude-mem-codex**, an unofficial fork of claude-mem that adds a Codex CLI observer provider. Marketplace: `claude-mem-codex`; plugin id: `claude-mem@claude-mem-codex`. Fork changes are listed in `CHANGES-FORK.md`.

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Build

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/claude-mem-codex/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, provides Python for Chroma)
- Node.js

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify) documents upstream claude-mem; this fork (claude-mem-codex) does not deploy `docs/public/`
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation

## Important

No need to edit the changelog ever, it's generated automatically.
