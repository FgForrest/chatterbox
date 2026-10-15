/**
 * The authorization catalog: every capability and MCP permission Chatterbox
 * knows, and the implications between them. The application, the identity
 * provider adapters read this one list
 * (`scripts/export-authz.ts` exports it), so nothing keeps a parallel enum.
 */

/** Capabilities of a person in the web application. */
export const CAPABILITIES = ["use", "org.curate", "access.manage"] as const;

/** One of {@link CAPABILITIES}. */
export type Capability = (typeof CAPABILITIES)[number];

/** Permissions of an MCP token; the names are the identity provider's role names. */
export const MCP_PERMISSIONS = [
    "knowledge:read",
    "transcripts:read",
    "summaries:read",
    "tasks:read",
    "tasks:write",
    "mail:read",
] as const;

/** One of {@link MCP_PERMISSIONS}. */
export type McpPermission = (typeof MCP_PERMISSIONS)[number];

/** Anything the catalog grants. */
export type Grant = Capability | McpPermission;

/** `from` granted means `to` is granted as well. */
export interface Implication {
    from: Grant;
    to: Grant;
}

/**
 * The implications of the catalog. Deliberately minimal: neither
 * `access.manage` nor `org.curate` implies `use`, and `access.manage` does
 * not imply `org.curate`.
 */
export const IMPLICATIONS: readonly Implication[] = [
    { from: "tasks:write", to: "tasks:read" },
];

/** Version of the exported catalog format; bump on any incompatible change. */
export const CATALOG_SCHEMA_VERSION = 1;

/** Human-readable purpose of each grant, for the export and the admin UI. */
export const GRANT_DESCRIPTIONS: Readonly<Record<Grant, string>> = {
    use: "Use Chatterbox",
    "org.curate": "Curate the Organization's content",
    "access.manage": "Manage who has access",
    "knowledge:read": "MCP: read knowledge",
    "transcripts:read": "MCP: read transcripts",
    "summaries:read": "MCP: read summaries",
    "tasks:read": "MCP: read tasks",
    "tasks:write": "MCP: change tasks",
    "mail:read": "MCP: read mail",
};

const CAPABILITY_SET = new Set<string>(CAPABILITIES);
const MCP_PERMISSION_SET = new Set<string>(MCP_PERMISSIONS);

/** Whether `value` is one of {@link CAPABILITIES}. */
export function isCapability(value: unknown): value is Capability {
    return typeof value === "string" && CAPABILITY_SET.has(value);
}

/** Whether `value` is one of {@link MCP_PERMISSIONS}. */
export function isMcpPermission(value: unknown): value is McpPermission {
    return typeof value === "string" && MCP_PERMISSION_SET.has(value);
}

/** Whether `value` is any grant of the catalog. */
export function isGrant(value: unknown): value is Grant {
    return isCapability(value) || isMcpPermission(value);
}
