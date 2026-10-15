import {
    CAPABILITIES,
    CATALOG_SCHEMA_VERSION,
    GRANT_DESCRIPTIONS,
    IMPLICATIONS,
    MCP_PERMISSIONS,
} from "@/lib/authz/catalog";

/** The provider-neutral authorization catalog export. */
export interface AuthzCatalogExport {
    schemaVersion: number;
    capabilities: { name: string; description: string }[];
    mcpPermissions: { name: string; description: string }[];
    implications: { from: string; to: string }[];
}

/**
 * The catalog as deterministic data: no URLs, no provider identifiers, no
 * secrets. Same input, same bytes.
 */
export function exportAuthzCatalog(): AuthzCatalogExport {
    return {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        capabilities: CAPABILITIES.map((name) => ({
            name,
            description: GRANT_DESCRIPTIONS[name],
        })),
        mcpPermissions: MCP_PERMISSIONS.map((name) => ({
            name,
            description: GRANT_DESCRIPTIONS[name],
        })),
        implications: IMPLICATIONS.map(({ from, to }) => ({ from, to })),
    };
}

/** {@link exportAuthzCatalog} as stable, pretty JSON with a trailing newline. */
export function serializeAuthzCatalog(): string {
    return `${JSON.stringify(exportAuthzCatalog(), null, 4)}\n`;
}
