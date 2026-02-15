# Scripts

## Installation Scripts

| Script | Purpose |
|--------|---------|
| `install.sh` | Full install: npm global + MCP server + hooks |
| `local-install.sh` | Dev install: npm link + MCP server + hooks (points at repo) |
| `update.sh` | Update: `npm update -g laminark` |
| `uninstall.sh` | Remove MCP server, hooks, and npm package |
| `verify-install.sh` | Check installation status |

## How It Works

Laminark installs via three steps:

1. **npm package** — `npm install -g laminark` puts `laminark-server` and `laminark-hook` on PATH
2. **MCP server** — `claude mcp add-json` registers the MCP server in `~/.claude/settings.json`
3. **Hooks** — Hook entries are merged into `~/.claude/settings.json` to capture session events

## Version Bumping

Laminark uses `MILESTONE.PHASE.SEQUENTIAL` versioning aligned with GSD (Get Shit Done) workflow.

### Format: `M.P.S`
- **M** = Milestone generation (1, 2, 3...)
- **P** = Absolute phase number (1, 2, 3... 21+)
- **S** = Sequential release within phase (0, 1, 2...)

### Automatic Bumping (CI/CD)

The GitHub Actions workflow automatically bumps the **patch** version (S) on every push to master:
```bash
2.21.0 → 2.21.1
```

This is for incremental fixes and updates within the same phase.

### Manual Bumping

When starting a **new phase** or **milestone**, manually run:

```bash
# New phase (phase 21 → 22)
./scripts/bump-version.sh phase
# 2.21.0 → 2.22.0

# New milestone (generation 2 → 3)
./scripts/bump-version.sh milestone
# 2.21.0 → 3.22.0
```

Then commit and push:
```bash
git add package.json
git commit -m "chore: bump to vX.Y.0 for phase Z"
git push
```

### Version History

- **v1.8.0** - Phase 8 (Milestone v1.0 complete)
- **v2.16.0** - Phase 16 (Milestone v2.0 complete)
- **v2.18.0** - Phase 18 (Milestone v2.1 complete)
- **v2.21.0** - Phase 21 (Milestone v2.2 complete)
