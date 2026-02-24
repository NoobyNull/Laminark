# /laminark:map-codebase

Map and ingest codebase knowledge into Laminark for instant recall.

## Usage

/laminark:map-codebase [directory]

## Instructions

When the user invokes this command:

1. Check if `.planning/codebase/` exists in the current project with .md files:
   - If YES: Offer to ingest these existing GSD docs directly. If the user agrees, call the `ingest_knowledge` MCP tool with the directory parameter set to the absolute path of `.planning/codebase/`.

2. If no existing docs found, check if GSD plugin is available:
   - Look for GSD commands (check if /gsd:map-codebase is available)
   - If GSD available: Tell the user to run `/gsd:map-codebase` first to generate codebase documentation, then return to ingest. Explain: "GSD will analyze your codebase and produce structured documentation in .planning/codebase/. Then I'll ingest it into Laminark for instant recall."
   - If GSD not available: Suggest installing the GSD plugin for codebase mapping, or manually placing markdown files in `.laminark/codebase/` and then calling this command with that directory path.

3. If a directory argument is provided, call `ingest_knowledge` with that directory path directly.

4. After successful ingestion, confirm with the returned stats: "Ingested X files (Y sections) into Laminark. Your codebase knowledge is now queryable with /laminark:recall."

## Examples

### Example 1: Existing GSD docs ready to ingest
User: /laminark:map-codebase
Analysis: Detects .planning/codebase/ exists
Response: "I found existing GSD documentation in .planning/codebase/. Ready to ingest 7 markdown files into Laminark?"
User: yes
Action: Call ingest_knowledge with directory=/absolute/path/.planning/codebase/
Result: "Ingested 7 files (42 sections) into Laminark. Your codebase knowledge is now queryable."

### Example 2: User provides explicit directory
User: /laminark:map-codebase /my/docs/codebase
Action: Call ingest_knowledge with directory=/my/docs/codebase/
Result: "Ingested 5 files (28 sections) into Laminark."

### Example 3: No docs found, GSD available
User: /laminark:map-codebase
Analysis: No .planning/codebase/ or .laminark/codebase/ found
Analysis: /gsd:map-codebase is available
Response: "No codebase documentation found. I can help you map your codebase using GSD. Run /gsd:map-codebase to analyze your project, then come back here to ingest the results."

## Notes

- **Delegation to GSD:** Laminark is a knowledge layer, not a codebase analysis tool. GSD handles mapping; Laminark handles remembering and recalling that knowledge.
- **Idempotent re-runs:** Running ingest_knowledge multiple times on the same directory is safe. Previously ingested sections are replaced, avoiding duplicates.
- **Instant recall:** After ingestion, query your codebase knowledge with `/laminark:recall {your question}`.
- **Per-project scoping:** All ingested knowledge is automatically scoped to the current project. Switching projects gives you access to that project's ingested knowledge.
- **Manual docs:** If you prefer not to use GSD, you can create markdown files manually in `.laminark/codebase/` with `## ` section headings. Each section becomes a queryable memory.

