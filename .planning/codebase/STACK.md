# Technology Stack

**Analysis Date:** 2026-02-08

## Languages

**Primary:**
- TypeScript 5.9.3 - All application code in `src/`

**Secondary:**
- None - Pure TypeScript/JavaScript codebase

## Runtime

**Environment:**
- Node.js v22.0.0+ (minimum required, v25.4.0 detected in system)

**Package Manager:**
- npm (uses package-lock.json)
- Lockfile: present (`package-lock.json`)

## Frameworks

**Core:**
- None - This is a library package (`@laminark/memory`), not a framework-based application

**Testing:**
- Vitest 4.0.18 - Test runner with globals enabled
- Config: `vitest.config.ts`

**Build/Dev:**
- tsdown 0.20.3 - TypeScript bundler for library builds
- tsx 4.21.0 - TypeScript execution for development
- TypeScript 5.9.3 - Type checking and compilation

## Key Dependencies

**Critical:**
- better-sqlite3 12.6.2 - Synchronous SQLite3 bindings (primary database driver)
- sqlite-vec 0.1.7-alpha.2 - Vector similarity search extension for SQLite
- zod 4.3.6 - Runtime type validation for API boundaries

**Infrastructure:**
- Node.js built-in modules: `node:crypto`, `node:fs`, `node:os`, `node:path`

## Configuration

**Environment:**
- No `.env` files present - Configuration via code
- Database path: `~/.laminark/data.db` (hardcoded in `src/shared/config.ts`)
- Project scoping via SHA-256 hash of canonical directory path

**Build:**
- `tsconfig.json` - TypeScript compiler config (ES2024 target, NodeNext modules)
- `tsdown.config.ts` - Build configuration (ESM output only)
- `vitest.config.ts` - Test configuration
- `.gitignore` - Excludes `node_modules/`, `dist/`, `*.db`, `*.db-wal`, `*.db-shm`, `.env`, `coverage/`

## Platform Requirements

**Development:**
- Node.js >= 22.0.0
- npm (any recent version)
- SQLite3 support (via better-sqlite3 native bindings)

**Production:**
- Command-line tool: `laminark-server` binary
- Target: npm package (`@laminark/memory`)
- Deployment: Distributed via npm registry

---

*Stack analysis: 2026-02-08*
