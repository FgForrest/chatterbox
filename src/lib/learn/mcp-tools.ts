/**
 * Riffado's read-only knowledge tools, as a Learn run's model sees them
 * over MCP (`/api/mcp/learn`, `mcp.ts`). Apart from the endpoint so the
 * bridge pass can name them without loading the database.
 */
export const LEARN_MCP_TOOLS = [
    {
        name: "find_entities",
        description:
            "Find the people, organizations, projects, products, terms and other things the knowledge base knows that a word or phrase from the transcript may name, best first, with why each matched.",
        inputSchema: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "The words as written in the transcript.",
                },
                type: {
                    type: "string",
                    description:
                        "Optional: `person`, or an entity type key, to narrow the search.",
                },
            },
            required: ["text"],
            additionalProperties: false,
        },
    },
    {
        name: "get_entity",
        description:
            "One person or thing the knowledge base knows, by id: its name, type, description and other names.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
        },
    },
    {
        name: "find_facts",
        description:
            "The current facts the knowledge base holds about one person or thing, by id.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
        },
    },
] as const;
