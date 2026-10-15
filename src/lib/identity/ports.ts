import type { JWTPayload } from "jose";
import type { Capability, McpPermission } from "@/lib/authz/catalog";

/** The person an ID token describes, after the token was verified. */
export interface VerifiedIdentity {
    issuer: string;
    subject: string;
    email: string | null;
    emailVerified: boolean;
    name: string | null;
    /** When the person last authenticated at the provider (`auth_time`). */
    authTime: Date | null;
}

/** What an MCP access token says about its subject. */
export interface McpTokenProfile {
    /**
     * `service` only for a token the provider marks as a service token of
     * a service-only client; everything else is a possible `user`, decided
     * by the account link, never by `client_id` alone.
     */
    kind: "user" | "service";
    clientId: string | null;
    permissions: Set<McpPermission>;
}

/**
 * Normalizes claims the server already verified (signature, issuer,
 * audience, expiry). One profile per token kind: ID token, the web
 * client's access token, an MCP access token.
 */
export interface IdentityClaimsProvider {
    readonly id: string;
    acceptsIdToken(claims: JWTPayload, clientId: string): boolean;
    acceptsAccessToken(claims: JWTPayload, clientId?: string): boolean;
    tokenClient(claims: JWTPayload): string | null;
    identityFromIdToken(
        issuer: string,
        claims: JWTPayload,
    ): VerifiedIdentity | null;
    capabilitiesFromAccessToken(claims: JWTPayload): Set<Capability>;
    mcpTokenProfile(
        claims: JWTPayload,
        options: { serviceClients: readonly string[] },
    ): McpTokenProfile;
}

/** Operations an access-management adapter really performs. */
export interface ProviderSupport {
    changeMembership: boolean;
    revokeSessions: boolean;
}

/** A person as the provider lists them. `id` is the provider subject. */
export interface AccessSubject {
    id: string;
    username: string | null;
    email: string | null;
    name: string | null;
    enabled: boolean;
}

/** Why a capability is held other than through its managed group. */
export type InheritedSource =
    | "direct-role"
    | "other-group"
    | "parent-group"
    | "composite";

/** The access of one subject as the provider has it now. */
export interface SubjectAccess {
    subject: AccessSubject;
    /** Every capability the subject's tokens would carry. */
    effective: Capability[];
    /** Capabilities granted through their managed group (the switchable part). */
    managed: Capability[];
    /** Effective capabilities that removing the managed group would not take away. */
    inherited: { capability: Capability; sources: InheritedSource[] }[];
    /** Opaque digest of the above; a change names the revision it was made against. */
    revision: string;
}

/** A requested change; only catalog capabilities, nothing provider-specific. */
export interface AccessChange {
    add: Capability[];
    remove: Capability[];
}

/** What a change really did, read back from the provider after writing. */
export interface AccessChangeResult {
    status: "applied" | "partial" | "noop";
    applied: AccessChange;
    failed: { capability: Capability; error: string }[];
    /** Removals that left the capability effective (inherited). */
    stillEffective: { capability: Capability; sources: InheritedSource[] }[];
    after: SubjectAccess;
}

/** One page of subjects. */
export interface SubjectPage {
    subjects: AccessSubject[];
    hasMore: boolean;
}

/** A subject with its effective and managed capabilities, for a list. */
export interface AccessListEntry {
    subject: AccessSubject;
    effective: Capability[];
    managed: Capability[];
}

/** One page of {@link AccessListEntry}. */
export interface AccessPage {
    entries: AccessListEntry[];
    hasMore: boolean;
}

/**
 * Access management at the provider, on behalf of the signed-in
 * administrator. Implementations never accept provider identifiers (realm,
 * group or role ids, URLs) from their callers: those come from validated
 * configuration.
 */
export interface AccessManagementPort {
    readonly support: ProviderSupport;
    listSubjects(query: {
        search?: string;
        first: number;
        max: number;
    }): Promise<SubjectPage>;
    listAccess(query: {
        search?: string;
        first: number;
        max: number;
    }): Promise<AccessPage>;
    getAccess(subjectId: string): Promise<SubjectAccess | null>;
    changeAccess(
        subjectId: string,
        change: AccessChange,
    ): Promise<AccessChangeResult>;
    revokeSessions(subjectId: string): Promise<void>;
}

/** What the provider says about a subject when asked by the access verifier. */
export type AccessVerification =
    | { status: "active"; capabilities: Set<Capability> }
    | { status: "disabled" }
    | { status: "missing" };

/**
 * Read-only verification of a subject's current access, used to keep a
 * holder's verified access fresh without their interactive login.
 */
export interface AccessVerifierPort {
    verify(subjectId: string): Promise<AccessVerification>;
}

/** How a provider call failed. */
export type IdentityProviderErrorKind =
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "rate_limited"
    | "unavailable"
    | "invalid_response"
    | "reauthentication_required";

/** A failed call to the identity provider. Never carries a token. */
export class IdentityProviderError extends Error {
    readonly kind: IdentityProviderErrorKind;
    readonly status: number | null;

    constructor(
        kind: IdentityProviderErrorKind,
        message: string,
        status: number | null = null,
    ) {
        super(message);
        this.name = "IdentityProviderError";
        this.kind = kind;
        this.status = status;
    }
}
