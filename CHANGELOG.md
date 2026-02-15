# Changelog

All notable changes to Laminark will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

> **Note on versioning:** Laminark uses `MILESTONE.PHASE.SEQUENTIAL` versioning (e.g., v2.21.0). The first digit is the milestone generation, the second is the absolute phase number, and the third is the sequential release within that phase. This aligns with the GSD (Get Shit Done) workflow structure.

## [2.21.0] - 2026-02-14

### Added
- Automatic debug path detection from error patterns
- Debug waypoint capture (error, attempt, failure, success, pivot, revert, discovery, resolution)
- KISS summaries for resolved debug paths
- Cross-session debug path linking
- D3 breadcrumb trail visualization with animated paths
- Path detail panel with waypoint timeline
- MCP tools: `start_path`, `resolve_path`, `show_path`, `list_paths`

## [2.18.0] - 2026-02-14

### Changed
- Replaced regex entity extraction with Haiku AI agents
- Migrated from @anthropic-ai/sdk to @anthropic-ai/claude-agent-sdk

## [2.16.0] - 2026-02-10

### Added
- Global plugin installation with project-aware session bootstrapping
- Tool discovery across all Claude Code config scopes
- Tool usage tracking per session and project
- Conversation-driven tool routing
- Tool search with hybrid FTS5+vector search
- Staleness management for tool registry

## [1.8.0] - 2026-02-09

### Added
- SQLite storage engine with WAL and crash recovery
- MCP interface with keyword search
- Automatic observation capture via hooks
- Vector embeddings with hybrid search
- Knowledge graph with entity extraction
- Interactive web visualization
