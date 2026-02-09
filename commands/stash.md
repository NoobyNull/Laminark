# /laminark:stash

Manually stash the current session's context for later retrieval.

## Usage

/laminark:stash [optional label]

## Instructions

When the user invokes this command:

1. Call the `save_memory` MCP tool to persist current observations, then call the stash handler to snapshot the current session
2. If a label is provided after the command, use it as the stash topic label
3. If no label is provided, one is generated automatically from the earliest observation
4. Confirm to the user that their context was stashed
5. Show the topic label and remind them about /laminark:resume

## Examples

User: /laminark:stash authentication implementation
Action: Stash current session context with label "authentication implementation"
Response: "Context stashed: 'authentication implementation'. Use /laminark:resume to return to it."

User: /laminark:stash
Action: Stash current session context with auto-generated label
Response: "Context stashed: 'Initial project setup and configur...'. Use /laminark:resume to return to it."

## Notes

- Stashing preserves a snapshot of the current session's observations
- The stash remains available across sessions until resumed or deleted
- Use /laminark:resume to list available stashes or restore a specific one
- Automatic stashing also occurs when topic shifts are detected during normal work
