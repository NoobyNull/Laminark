---
phase: 07-knowledge-graph-and-advanced-intelligence
verified: 2026-02-08T21:45:00Z
status: gaps_found
score: 3/5
gaps:
  - truth: "Entities (Project, File, Decision, Problem, Solution, Tool, Person) are automatically extracted from observations and stored as graph nodes"
    status: failed
    reason: "Entity extraction pipeline exists but is NOT wired into observation capture flow"
    artifacts:
      - path: "src/graph/entity-extractor.ts"
        issue: "extractAndPersist() exists and tested, but never called from hooks or analysis worker"
      - path: "src/index.ts"
        issue: "processUnembedded() does not call entity extraction after embedding"
    missing:
      - "Wire extractAndPersist() into processUnembedded() in src/index.ts after embedding succeeds"
      - "Wire extractAndPersist() into hook capture flow for immediate extraction"
  - truth: "Typed relationships (uses, depends_on, decided_by, related_to, part_of, caused_by, solved_by) connect entities as graph edges"
    status: failed
    reason: "Relationship detection pipeline exists but is NOT wired into observation capture flow"
    artifacts:
      - path: "src/graph/relationship-detector.ts"
        issue: "detectAndPersist() exists and tested, but never called from hooks or analysis worker"
      - path: "src/index.ts"
        issue: "processUnembedded() does not call relationship detection after entity extraction"
    missing:
      - "Wire detectAndPersist() into processUnembedded() in src/index.ts after extractAndPersist() succeeds"
      - "Pass extracted entities from extractAndPersist() to detectAndPersist() to create edges"
  - truth: "Curation agent periodically merges similar observations and generates consolidated summaries during quiet periods"
    status: failed
    reason: "Curation agent exists but is NOT instantiated or started in the main server lifecycle"
    artifacts:
      - path: "src/graph/curation-agent.ts"
        issue: "CurationAgent class and runCuration() exist, but never instantiated in src/index.ts"
      - path: "src/index.ts"
        issue: "No CurationAgent instantiation, no start() call, no quiet period trigger"
    missing:
      - "Instantiate CurationAgent in src/index.ts with background interval (5 minutes)"
      - "Call agent.start() after server initialization"
      - "Call agent.stop() in shutdown handlers"
      - "Optionally: trigger onSessionEnd() from session stop hook"
---

# Phase 7: Knowledge Graph and Advanced Intelligence Verification Report

**Phase Goal:** Observations are connected into a navigable knowledge graph of entities and relationships, with high-quality embeddings from Claude's own reasoning.

**Verified:** 2026-02-08T21:45:00Z

**Status:** gaps_found

**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                                                                                      | Status       | Evidence                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Entities (Project, File, Decision, Problem, Solution, Tool, Person) are automatically extracted from observations and stored as graph nodes              | ✗ FAILED     | Pipeline exists (extractAndPersist in entity-extractor.ts) but NOT called from hooks or analysis worker. Only used in tests.           |
| 2   | Typed relationships (uses, depends_on, decided_by, related_to, part_of, caused_by, solved_by) connect entities as graph edges                            | ✗ FAILED     | Pipeline exists (detectAndPersist in relationship-detector.ts) but NOT called from hooks or analysis worker. Only used in tests.       |
| 3   | Claude can query the knowledge graph via MCP tool (e.g., "what files does this decision affect?" returns traversal results)                              | ✓ VERIFIED   | query_graph MCP tool registered in src/index.ts:148, uses traverseFrom() for graph traversal                                           |
| 4   | Graph enforces entity type taxonomy and caps node degree at 50 edges, preventing unnavigable hairball growth                                             | ✓ VERIFIED   | Type checks in schema, enforceMaxDegree() in constraints.ts, MAX_NODE_DEGREE constant. Constraint enforcement exists but not triggered |
| 5   | Curation agent periodically merges similar observations and generates consolidated summaries during quiet periods                                         | ✗ FAILED     | Agent exists (CurationAgent class) but NOT instantiated or started in src/index.ts. No periodic execution, no quiet period trigger.    |

**Score:** 3/5 truths verified

### Required Artifacts

| Artifact                                  | Expected                                                                  | Status      | Details                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `src/graph/types.ts`                      | Entity/relationship types, GraphNode/GraphEdge interfaces                 | ✓ VERIFIED  | All 7 entity types, 7 relationship types, type guards, MAX_NODE_DEGREE=50              |
| `src/graph/schema.ts`                     | Graph schema, traverseFrom, upsertNode, insertEdge                        | ✓ VERIFIED  | initGraphSchema, traverseFrom (recursive CTE), upsertNode, insertEdge, query builders  |
| `src/graph/migrations/001-graph-tables.ts`| Graph tables DDL with constraints                                         | ✓ VERIFIED  | graph_nodes and graph_edges tables with CHECK constraints, indexes, foreign keys       |
| `src/graph/entity-extractor.ts`           | extractEntities, extractAndPersist                                        | ⚠️ ORPHANED | Exists and tested (41 tests pass) but never called from main flow                      |
| `src/graph/extraction-rules.ts`           | 7 entity extraction rules (filePathRule, toolRule, etc.)                  | ✓ VERIFIED  | All 7 rules implemented, curated KNOWN_TOOLS list (~80 tools)                          |
| `src/graph/relationship-detector.ts`      | detectRelationships, detectAndPersist                                     | ⚠️ ORPHANED | Exists and tested (27 tests pass) but never called from main flow                      |
| `src/graph/constraints.ts`                | enforceMaxDegree, mergeEntities, findDuplicateEntities                    | ⚠️ ORPHANED | Exists and tested but constraint enforcement not triggered automatically                |
| `src/graph/temporal.ts`                   | Time-range queries, recency scoring, staleness detection                  | ✓ VERIFIED  | getObservationsByTimeRange, calculateRecencyScore, detectStaleness                      |
| `src/graph/staleness.ts`                  | detectStaleness, flagStaleObservation                                     | ⚠️ ORPHANED | Exists but not called from curation agent (which is not running)                        |
| `src/graph/curation-agent.ts`             | CurationAgent, runCuration                                                | ⚠️ ORPHANED | Exists and tested (17 tests pass) but NOT instantiated or started in src/index.ts      |
| `src/graph/observation-merger.ts`         | findMergeableClusters, mergeObservationCluster                            | ⚠️ ORPHANED | Exists but only called from curation agent (which is not running)                       |
| `src/mcp/tools/query-graph.ts`            | query_graph MCP tool                                                      | ✓ WIRED     | Registered in src/index.ts:148, implements graph traversal and observation excerpts     |
| `src/mcp/tools/graph-stats.ts`            | graph_stats MCP tool                                                      | ✓ WIRED     | Registered in src/index.ts:149, provides node/edge counts, degree stats, duplicate detection |
| `src/analysis/engines/piggyback.ts`       | PiggybackEngine with semantic signal extraction                           | ✓ VERIFIED  | Implements EmbeddingEngine interface, signal cache, 70/30 blending                      |
| `src/analysis/hybrid-selector.ts`         | 3-mode embedding strategy selector                                        | ✓ VERIFIED  | createEmbeddingStrategy factory, LAMINARK_EMBEDDING_MODE env var                        |

### Key Link Verification

| From                                | To                                    | Via                                                  | Status       | Details                                                                           |
| ----------------------------------- | ------------------------------------- | ---------------------------------------------------- | ------------ | --------------------------------------------------------------------------------- |
| `src/graph/schema.ts`               | `src/graph/types.ts`                  | imports EntityType, RelationshipType                 | ✓ WIRED      | Type-safe queries confirmed                                                       |
| `src/graph/schema.ts`               | SQLite database                       | better-sqlite3 db.exec, db.prepare                   | ✓ WIRED      | DDL and queries verified via tests                                                |
| `src/mcp/tools/query-graph.ts`      | `src/graph/schema.ts`                 | calls initGraphSchema, traverseFrom, getNodeByNameAndType | ✓ WIRED  | MCP tool uses graph traversal                                                     |
| `src/mcp/tools/graph-stats.ts`      | `src/graph/schema.ts`                 | calls initGraphSchema, direct SQL for stats          | ✓ WIRED      | MCP tool provides graph health dashboard                                          |
| `src/index.ts` processUnembedded    | `src/graph/entity-extractor.ts`       | should call extractAndPersist after embedding        | ✗ NOT_WIRED  | NO import, NO call. Entity extraction never happens.                              |
| `src/index.ts` processUnembedded    | `src/graph/relationship-detector.ts`  | should call detectAndPersist after entity extraction | ✗ NOT_WIRED  | NO import, NO call. Relationship detection never happens.                         |
| `src/index.ts` server lifecycle     | `src/graph/curation-agent.ts`         | should instantiate CurationAgent, call start/stop    | ✗ NOT_WIRED  | NO import, NO instantiation. Curation never runs.                                 |
| `src/graph/curation-agent.ts`       | `src/graph/observation-merger.ts`     | runCuration calls findMergeableClusters, merge       | ✓ WIRED      | Agent orchestrates merging correctly (but agent not running)                      |
| `src/graph/curation-agent.ts`       | `src/graph/constraints.ts`            | runCuration calls findDuplicateEntities, mergeEntities | ✓ WIRED    | Agent orchestrates dedup correctly (but agent not running)                        |
| `src/graph/curation-agent.ts`       | `src/graph/staleness.ts`              | runCuration calls detectStaleness, flagStaleObservation | ✓ WIRED   | Agent orchestrates staleness detection (but agent not running)                    |

### Anti-Patterns Found

| File               | Line | Pattern                              | Severity | Impact                                                                          |
| ------------------ | ---- | ------------------------------------ | -------- | ------------------------------------------------------------------------------- |
| src/index.ts       | 87-130 | Observation processing without entity extraction | 🛑 Blocker | Knowledge graph remains empty — observations are embedded but entities never extracted |
| src/index.ts       | 87-130 | Observation processing without relationship detection | 🛑 Blocker | Graph edges never created — no relationships between entities |
| src/index.ts       | 143-156 | Server lifecycle without curation agent | 🛑 Blocker | No periodic graph maintenance — duplicates accumulate, stale observations never flagged |

### Human Verification Required

None — all automated checks completed. The gaps are clear: wiring is missing, not functionality.

### Gaps Summary

Phase 7 implemented a **comprehensive knowledge graph infrastructure** with:
- ✓ Complete graph schema (nodes, edges, constraints, indexes)
- ✓ Entity extraction for all 7 types (tested, 41 tests passing)
- ✓ Relationship detection for all 7 types (tested, 27 tests passing)
- ✓ MCP query tools for Claude (query_graph, graph_stats)
- ✓ Curation agent with merging, dedup, staleness detection (tested, 17 tests passing)
- ✓ 614 total tests passing across all modules

**However, the graph infrastructure is completely orphaned.** All the extraction, relationship detection, and curation logic exists and is well-tested, but **nothing wires these modules into the actual observation processing flow.**

**Three critical integrations are missing:**

1. **Entity extraction not triggered** — `extractAndPersist()` should be called in `processUnembedded()` after embedding succeeds, but it's not. The knowledge graph remains empty because no entities are ever extracted from observations.

2. **Relationship detection not triggered** — `detectAndPersist()` should be called after entity extraction to create edges between co-occurring entities, but it's not. Even if entities were extracted, they would have no connections.

3. **Curation agent not running** — `CurationAgent` should be instantiated and started in the main server lifecycle, but it's not. No periodic maintenance means duplicates accumulate, stale observations never get flagged, and low-value noise never gets pruned.

**Result:** The knowledge graph tooling is read-only (Claude can query an empty graph) but write functionality is completely disconnected. Observations flow through the system, get embedded, but never populate the graph.

---

_Verified: 2026-02-08T21:45:00Z_
_Verifier: Claude (gsd-verifier)_
