import type { Capability, McpPermission } from "@/lib/authz/catalog";

/**
 * Who an actor is:
 * - `user`: a person with a Chatterbox account;
 * - `service`: a configured service client of the identity provider,
 *   acting in the Organization's data context only;
 * - `local-org`: the organization account of an installation without
 *   identity-provider authorization.
 */
export type ActorKind = "user" | "service" | "local-org";

/**
 * The server-side authorization context of one request. Built only by the
 * server from a verified session, token or key; never taken from a
 * request body.
 *
 * `actorId` is who acts: the user id for `user` and `local-org`, the
 * provider subject for `service`. It is never replaced by the organization
 * account's id to satisfy an ownership check: the owner of the data and
 * the data context are separate inputs of every check.
 */
export interface ActorContext {
    kind: ActorKind;
    actorId: string;
    /** The identity provider's issuer; null for local identities. */
    issuer: string | null;
    /** The identity provider's subject; null for local identities. */
    subject: string | null;
    /** Capabilities, already expanded by the catalog's implications. */
    capabilities: ReadonlySet<Capability>;
    /** The client the credential was issued to (`azp`), when there is one. */
    clientId: string | null;
    /** What the client credential permits (MCP); empty for the web. */
    clientPermissions: ReadonlySet<McpPermission>;
    /** When the identity provider last confirmed the capabilities; null for local identities. */
    verifiedAt: Date | null;
}

/** Capabilities of everybody in `AUTHZ_MODE=local`: using the application, nothing more. */
export const LOCAL_MODE_CAPABILITIES: ReadonlySet<Capability> = new Set([
    "use",
]);
