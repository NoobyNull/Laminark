# /laminark:map-codebase

Map and ingest codebase knowledge into Laminark for instant recall.

## Usage

/laminark:map-codebase [optional directory path]

## Instructions

When the user invokes this command:

1. First, check if `.planning/codebase/` exists in the current project and contains .md files:
   - If YES (GSD output is already available):
     - Offer to ingest these existing docs: "I found codebase documentation in `.planning/codebase/`. Would you like me to ingest these into Laminark for instant recall?"
     - If user agrees, call `ingest_knowledge` MCP tool with the directory parameter set to the absolute path of `.planning/codebase/` (e.g., `/path/to/project/.planning/codebase/`)
     - After successful ingestion, confirm with stats: "Ingested X files (Y sections) into Laminark. You can now query this knowledge with /laminark:recall."

2. If no existing docs are found, check if GSD plugin is available:
   - Look for GSD as an available slash command or plugin (GSD plugin would provide `/gsd:` commands)
   - If GSD is available: Tell the user "GSD can analyze your codebase and produce structured documentation. Run `/gsd:map-codebase` first to generate these docs, then I'll ingest them into Laminark for instant recall."
   - If GSD is not available: Suggest either installing the GSD plugin, or manually placing markdown documentation in `.laminark/codebase/` directory

3. If a directory argument is provided explicitly:
   - Call `ingest_knowledge` directly with that directory path (e.g., `/laminark:map-codebase /home/user/docs/`)
   - After ingestion, show stats and confirm readiness for queries

## Examples

**Scenario 1: GSD docs already exist**

User: /laminark:map-codebase
Context: `.planning/codebase/` exists with several .md files
Response: "I found codebase documentation in `.planning/codebase/` (STACK.md, ARCHITECTURE.md, etc.). Ingest these into Laminark now?"
User: Yes
Action: Call `ingest_knowledge` with directory="{projectPath}/.planning/codebase/"
Result: "Ingested 3 files (27 sections) into Laminark. You can now query this knowledge with /laminark:recall."

**Scenario 2: No docs yet, GSD available**

User: /laminark:map-codebase
Context: No `.planning/codebase/` exists, but `/gsd:map-codebase` is available
Response: "No codebase documentation found. Run `/gsd:map-codebase` to analyze your codebase first, then I'll ingest it here for instant recall. GSD will produce structured markdown docs for architecture, dependencies, tech stack, etc."

**Scenario 3: Explicit directory provided**

User: /laminark:map-codebase /home/user/my-docs/
Action: Call `ingest_knowledge` with directory="/home/user/my-docs/"
Result: "Ingested 2 files (15 sections) into Laminark. You can now query this knowledge with /laminark:recall."

## Notes

- **Architecture**: Laminark is the knowledge layer (memory + recall), while GSD is the analysis layer (codebase mapping + documentation generation). Run GSD to produce docs, then use /laminark:map-codebase to ingest them.
- **Idempotent**: Re-running this command on the same directory is safe. Stale sections are automatically cleaned up, and new ones are created from fresh docs.
- **Immediately queryable**: After ingestion, all sections are classified as "discovery" and immediately visible to search and recall operations.
- **Per-project scoping**: All ingested observations are automatically scoped to your current project. Different projects maintain separate knowledge stores.
- **Source tagging**: Ingested sections are tagged with source="ingest:{filename}" for easy filtering and identification in queries.

