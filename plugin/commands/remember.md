# /laminark:remember

Save a memory to Laminark for future retrieval.

## Usage

/laminark:remember {text to remember}

## Instructions

When the user invokes this command:

1. Take the text provided after the command as the memory content
2. Call the `save_memory` MCP tool with:
   - `content`: The user's text exactly as provided
   - `source`: "slash:remember" (identifies this as an explicit user save)
3. Confirm to the user that the memory has been saved
4. Show a brief snippet of what was saved (first 100 characters)

## Examples

User: /laminark:remember The auth system uses JWT with 15-minute expiry and refresh tokens stored in httpOnly cookies
Action: Call save_memory with content="The auth system uses JWT with 15-minute expiry and refresh tokens stored in httpOnly cookies" and source="slash:remember"
Response: "Saved to memory: 'The auth system uses JWT with 15-minute expiry and refresh tokens stored in httpOnly cookies'"

User: /laminark:remember We decided to use Postgres instead of MySQL for the new service because of JSONB support
Action: Call save_memory with the full text
Response: "Saved to memory: 'We decided to use Postgres instead of MySQL for the new serv...'"

## Notes

- Memories saved via /laminark:remember are high-priority in search results (source: "slash:remember")
- These memories persist across sessions and are included in session context injection
- If no text is provided after the command, ask the user what they'd like to remember
