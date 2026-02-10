# /laminark:status

Show Laminark system status: connection info, memory count, token estimates, and capabilities.

## Usage

/laminark:status

## Instructions

When the user invokes this command:

1. Call the `status` MCP tool with no arguments
2. Present the returned dashboard directly to the user

The tool returns a formatted status report including:
- **Connection**: project path, project hash, database path, uptime
- **Capabilities**: vector search availability, embedding worker status
- **Memories**: observation count, embedded count, session count, stashed threads
- **Tokens**: estimated total tokens across all stored memories
- **Knowledge Graph**: node and edge counts

## Examples

User: /laminark:status
Action: Call the status MCP tool
Response: Display the formatted status dashboard

## Notes

- This is a read-only diagnostic command with no side effects
- Token estimates use the ~4 chars/token heuristic
- Uptime reflects time since the MCP server process started
