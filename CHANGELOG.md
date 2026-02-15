# Changelog

All notable changes to Laminark will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [v2.2] - 2026-02-14

### Added
- Automatic debug path detection from error patterns
- Debug waypoint capture (error, attempt, failure, success, pivot, revert, discovery, resolution)
- KISS summaries for resolved debug paths
- Cross-session debug path linking
- D3 breadcrumb trail visualization with animated paths
- Path detail panel with waypoint timeline
- MCP tools: `start_path`, `resolve_path`, `show_path`, `list_paths`

## [v2.1] - 2026-02-14

### Changed
- Replaced regex entity extraction with Haiku AI agents
- Migrated from @anthropic-ai/sdk to @anthropic-ai/claude-agent-sdk

## [v2.0] - 2026-02-10

### Added
- Global plugin installation with project-aware session bootstrapping
- Tool discovery across all Claude Code config scopes
- Tool usage tracking per session and project
- Conversation-driven tool routing
- Tool search with hybrid FTS5+vector search
- Staleness management for tool registry

## [v1.0] - 2026-02-09

### Added
- SQLite storage engine with WAL and crash recovery
- MCP interface with keyword search
- Automatic observation capture via hooks
- Vector embeddings with hybrid search
- Knowledge graph with entity extraction
- Interactive web visualization
