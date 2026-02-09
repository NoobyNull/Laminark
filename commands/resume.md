# /laminark:resume

Resume a previously stashed context thread, or list all available stashed threads.

## Usage

/laminark:resume
/laminark:resume {stash-id}

## Instructions

When the user invokes this command:

### List mode (no ID provided)

1. Call the `topic_context` MCP tool with no arguments (or limit: 5)
2. Present the stashed threads as a numbered list showing:
   - Topic label
   - How long ago it was stashed
   - Brief summary (first 80 characters)
3. Tell the user they can resume a specific thread by providing its ID

### Resume mode (ID provided)

1. Call the `topic_context` MCP tool to look up the stash
2. Restore the context from the stash observations into the conversation
3. Confirm to the user which thread was resumed and how many observations were restored
4. Summarize the key context from the restored thread so the user can pick up where they left off

## Examples

User: /laminark:resume
Action: Call topic_context to list stashed threads
Response: Show numbered list of available threads with topic labels and timestamps

User: /laminark:resume abc123def456
Action: Resume the specific stash, inject its context
Response: "Resumed: 'JWT authentication' -- Context restored with 5 observations. Here's where you left off: ..."

## Notes

- Only threads with status "stashed" are shown (already resumed threads are excluded)
- Resuming a thread marks it as "resumed" so it no longer appears in the list
- The restored context includes observation snapshots from the time of stashing
- If no stashed threads exist, inform the user they are working in a single thread
