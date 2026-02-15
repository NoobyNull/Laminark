# /laminark:recall

Search Laminark memories by description or topic.

## Usage

/laminark:recall {description of what you're looking for}

## Instructions

When the user invokes this command:

1. Take the text provided after the command as the search query
2. Call the `search` MCP tool with:
   - `query`: The user's search description
   - `limit`: 10 (show top 10 results)
3. Present the results to the user in a readable format:
   - Show each result with its relevance score, a content snippet, the source, and when it was created
   - Group results by relevance tier if helpful (highly relevant, somewhat relevant)
   - If results include memories from different sessions, note which session they came from

## Response Format

Present results like this:

**Memory Search: "{query}"**

Found {N} relevant memories:

1. **[{score}% match]** {content snippet, first 200 chars}
   _{source} | {relative time}_

2. **[{score}% match]** {content snippet}
   _{source} | {relative time}_

...

_Use the search tool for more specific queries, or get_observations for full details on any memory._

## Examples

User: /laminark:recall authentication decisions
Action: Call search with query="authentication decisions"
Response: Show top results about auth-related memories with scores and snippets

User: /laminark:recall what database did we choose
Action: Call search with query="what database did we choose"
Response: Show results mentioning database selection decisions

## Notes

- Results use hybrid search (keyword + semantic) for best matching
- If no results are found, suggest the user try different search terms or check if they have saved any memories yet
- If no query is provided after the command, ask the user what they'd like to search for
- For detailed view of any result, Claude can use the get_observations MCP tool with the observation ID
