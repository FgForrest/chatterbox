import { MCP_PERMISSIONS, type McpPermission } from "@/lib/authz/catalog";
import { keycloakClaims } from "@/lib/identity/providers/keycloak/claims";

/** The permissions of the external MCP server: the catalog's MCP permissions. */
export const MCP_ROLES = MCP_PERMISSIONS;

/** One of {@link MCP_ROLES}. */
export type McpRole = McpPermission;

/**
 * The MCP permissions a token grants: the catalog roles of the `audience`
 * client under `resource_access`, with the catalog's implications
 * (`tasks:write` brings `tasks:read`).
 */
export function rolesFromPayload(
    payload: Record<string, unknown>,
    audience: string,
): Set<McpRole> {
    return keycloakClaims({
        rolesClient: "",
        permissionsSource: "roles",
        mcpAudience: audience,
    }).mcpTokenProfile(payload, { serviceClients: [] }).permissions;
}
