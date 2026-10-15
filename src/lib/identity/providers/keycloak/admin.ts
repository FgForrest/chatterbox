import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import {
    CAPABILITIES,
    type Capability,
    isCapability,
} from "@/lib/authz/catalog";
import {
    type AccessChange,
    type AccessChangeResult,
    type AccessListEntry,
    type AccessManagementPort,
    type AccessPage,
    type AccessSubject,
    IdentityProviderError,
    type InheritedSource,
    type SubjectAccess,
    type SubjectPage,
} from "@/lib/identity/ports";
import type { KeycloakConfig } from "@/lib/identity/providers/keycloak/config";
import {
    adminPath,
    createKeycloakHttp,
    type KeycloakHttp,
} from "@/lib/identity/providers/keycloak/http";

interface UserRepresentation {
    id: string;
    username?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    enabled?: boolean;
}

interface GroupRepresentation {
    id: string;
    path?: string;
}

interface RoleRepresentation {
    name: string;
}

interface RoleMappings {
    clientMappings?: Record<
        string,
        { id: string; client?: string; mappings?: RoleRepresentation[] }
    >;
}

function subjectOf(user: UserRepresentation): AccessSubject {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
    return {
        id: user.id,
        username: user.username ?? null,
        email: user.email?.toLowerCase() ?? null,
        name: name || null,
        enabled: user.enabled !== false,
    };
}

function capabilitiesOf(roles: RoleRepresentation[]): Set<Capability> {
    return new Set(roles.map((role) => role.name).filter(isCapability));
}

function sorted(values: Iterable<Capability>): Capability[] {
    const held = new Set(values);
    return CAPABILITIES.filter((capability) => held.has(capability));
}

/** Opaque digest of what a change is made against. */
export function accessRevision(
    access: Omit<SubjectAccess, "revision">,
): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                enabled: access.subject.enabled,
                effective: access.effective,
                managed: access.managed,
                inherited: access.inherited,
            }),
        )
        .digest("base64url")
        .slice(0, 22);
}

function ancestorPaths(path: string): string[] {
    const parts = path.split("/").filter(Boolean);
    return parts.slice(0, -1).map((_, index) => {
        return `/${parts.slice(0, index + 1).join("/")}`;
    });
}

/**
 * Reads a realm's users, groups and role mappings with an Admin API
 * client. Shared by the delegated administration and the verifier.
 */
export class KeycloakAccessReader {
    private clientUuid: Promise<string> | null = null;
    private groupPaths: Promise<Map<Capability, string>> | null = null;

    constructor(
        private readonly http: KeycloakHttp,
        private readonly config: KeycloakConfig,
        private readonly diagnosticToken?: () => Promise<string>,
    ) {}

    /** The internal id of the roles client, from a managed group's mappings. */
    rolesClientUuid(): Promise<string> {
        this.clientUuid ??= this.resolveClientUuid().catch((error) => {
            this.clientUuid = null;
            throw error;
        });
        return this.clientUuid;
    }

    private async resolveClientUuid(): Promise<string> {
        const groups = this.config.groups;
        if (groups) {
            const mappings = await this.http.get<RoleMappings>(
                adminPath`/groups/${groups.use}/role-mappings`,
            );
            const client = mappings.clientMappings?.[this.config.rolesClient];
            if (client?.id) return client.id;
            if (this.diagnosticToken) {
                try {
                    const claims = decodeJwt(await this.diagnosticToken());
                    const access = claims.resource_access as
                        | Record<string, { roles?: unknown }>
                        | undefined;
                    const roles = (clientId: string) => {
                        const value = access?.[clientId]?.roles;
                        return Array.isArray(value)
                            ? value.filter(
                                  (role): role is string =>
                                      typeof role === "string",
                              )
                            : [];
                    };
                    console.error(
                        "[access] administrator token role diagnostics",
                        {
                            managementRoles: roles("realm-management"),
                            applicationRoles: roles(this.config.rolesClient),
                        },
                    );
                } catch {
                    console.error(
                        "[access] administrator token diagnostics unavailable",
                    );
                }
            }
            console.error("[access] roles client mapping not found", {
                realm: this.config.realm,
                groupId: groups.use,
                expectedClient: this.config.rolesClient,
                returnedClients: Object.entries(
                    mappings.clientMappings ?? {},
                ).map(([key, mapping]) => ({
                    key,
                    id: mapping.id,
                    client: mapping.client,
                    roles: (mapping.mappings ?? []).map((role) => role.name),
                })),
            });
            throw new IdentityProviderError(
                "invalid_response",
                `The managed group of "use" grants no role of ${this.config.rolesClient}`,
            );
        }
        const clients = await this.http.get<{ id: string }[]>(
            adminPath`/clients`,
            {
                clientId: this.config.rolesClient,
            },
        );
        const client = clients.find(Boolean);
        if (!client) {
            throw new IdentityProviderError(
                "invalid_response",
                `Client ${this.config.rolesClient} not found`,
            );
        }
        return client.id;
    }

    /** Paths of the managed groups, to recognise their subgroups. */
    private managedGroupPaths(): Promise<Map<Capability, string>> {
        const groups = this.config.groups;
        if (!groups) return Promise.resolve(new Map());
        this.groupPaths ??= Promise.all(
            CAPABILITIES.map(async (capability) => {
                const group = await this.http.get<GroupRepresentation>(
                    adminPath`/groups/${groups[capability]}`,
                );
                return [capability, group.path ?? ""] as const;
            }),
        )
            .then((entries) => new Map(entries))
            .catch((error) => {
                this.groupPaths = null;
                throw error;
            });
        return this.groupPaths;
    }

    async user(subjectId: string): Promise<UserRepresentation | null> {
        try {
            return await this.http.get<UserRepresentation>(
                adminPath`/users/${subjectId}`,
            );
        } catch (error) {
            if (
                error instanceof IdentityProviderError &&
                error.kind === "not_found"
            ) {
                return null;
            }
            throw error;
        }
    }

    async effectiveCapabilities(subjectId: string): Promise<Set<Capability>> {
        const uuid = await this.rolesClientUuid();
        return capabilitiesOf(
            await this.http.get<RoleRepresentation[]>(
                adminPath`/users/${subjectId}/role-mappings/clients/${uuid}/composite`,
            ),
        );
    }

    private async groupCapabilities(
        groupId: string,
        uuid: string,
    ): Promise<Set<Capability>> {
        return capabilitiesOf(
            await this.http.get<RoleRepresentation[]>(
                adminPath`/groups/${groupId}/role-mappings/clients/${uuid}/composite`,
            ),
        );
    }

    async access(subjectId: string): Promise<SubjectAccess | null> {
        const user = await this.user(subjectId);
        if (!user) return null;
        const uuid = await this.rolesClientUuid();
        const managedGroups = this.config.groups;
        const [effective, direct, memberships, paths] = await Promise.all([
            this.effectiveCapabilities(subjectId),
            this.http
                .get<RoleRepresentation[]>(
                    adminPath`/users/${subjectId}/role-mappings/clients/${uuid}`,
                )
                .then(capabilitiesOf),
            this.http.getAll<GroupRepresentation>(
                adminPath`/users/${subjectId}/groups`,
                { briefRepresentation: "false" },
            ),
            this.managedGroupPaths(),
        ]);

        const managed = new Set<Capability>();
        const sources = new Map<Capability, Set<InheritedSource>>();
        const addSource = (capability: Capability, source: InheritedSource) => {
            if (!effective.has(capability)) return;
            sources.set(
                capability,
                new Set([...(sources.get(capability) ?? []), source]),
            );
        };
        for (const capability of direct) addSource(capability, "direct-role");

        const managedIds = new Map<string, Capability>(
            managedGroups
                ? CAPABILITIES.map((capability) => [
                      managedGroups[capability],
                      capability,
                  ])
                : [],
        );
        const pathToCapability = new Map<string, Capability>(
            [...paths].map(([capability, path]) => [path, capability]),
        );
        const ancestorCache = new Map<string, Set<Capability>>();
        for (const group of memberships) {
            const own = managedIds.get(group.id);
            if (own) managed.add(own);
            const granted = await this.groupCapabilities(group.id, uuid);
            for (const capability of granted) {
                if (capability !== own) addSource(capability, "other-group");
            }
            for (const path of ancestorPaths(group.path ?? "")) {
                const ancestorCapability = pathToCapability.get(path);
                if (ancestorCapability) {
                    addSource(ancestorCapability, "parent-group");
                    continue;
                }
                let inheritedFromAncestor = ancestorCache.get(path);
                if (!inheritedFromAncestor) {
                    const ancestor = await this.http.get<GroupRepresentation>(
                        adminPath`/group-by-path/${path.slice(1)}`.replaceAll(
                            "%2F",
                            "/",
                        ),
                    );
                    inheritedFromAncestor = await this.groupCapabilities(
                        ancestor.id,
                        uuid,
                    );
                    ancestorCache.set(path, inheritedFromAncestor);
                }
                for (const capability of inheritedFromAncestor) {
                    addSource(capability, "parent-group");
                }
            }
        }
        for (const capability of effective) {
            if (!managed.has(capability) && !sources.has(capability)) {
                addSource(capability, "composite");
            }
        }

        const base = {
            subject: subjectOf(user),
            effective: sorted(effective),
            managed: sorted(managed),
            inherited: sorted(sources.keys()).map((capability) => ({
                capability,
                sources: [...(sources.get(capability) ?? [])].sort(),
            })),
        };
        return { ...base, revision: accessRevision(base) };
    }
}

/**
 * Delegated access management in Keycloak: group membership of the three
 * managed groups and logout, called with the signed-in administrator's own
 * token. Needs `realm-management/manage-users` and `view-clients`.
 */
export function keycloakAdmin(
    config: KeycloakConfig,
    token: () => Promise<string>,
    http: KeycloakHttp = createKeycloakHttp({
        baseUrl: config.baseUrl,
        realm: config.realm,
        token,
    }),
): AccessManagementPort {
    const groups = config.groups;
    if (!groups) {
        throw new Error("Keycloak access management needs the managed groups");
    }
    const reader = new KeycloakAccessReader(http, config, token);

    return {
        support: { changeMembership: true, revokeSessions: true },

        async listSubjects({ search, first, max }): Promise<SubjectPage> {
            const page = await http.get<UserRepresentation[]>(
                adminPath`/users`,
                {
                    first,
                    max: max + 1,
                    briefRepresentation: "true",
                    ...(search ? { search } : {}),
                },
            );
            return {
                subjects: page.slice(0, max).map(subjectOf),
                hasMore: page.length > max,
            };
        },

        async listAccess({ search, first, max }): Promise<AccessPage> {
            const page = await http.get<UserRepresentation[]>(
                adminPath`/users`,
                {
                    first,
                    max: max + 1,
                    briefRepresentation: "true",
                    ...(search ? { search } : {}),
                },
            );
            const members = new Map<Capability, Set<string>>();
            for (const capability of CAPABILITIES) {
                const list = await http.getAll<{ id: string }>(
                    adminPath`/groups/${groups[capability]}/members`,
                    { briefRepresentation: "true" },
                );
                members.set(capability, new Set(list.map((user) => user.id)));
            }
            const entries: AccessListEntry[] = [];
            for (const user of page.slice(0, max)) {
                entries.push({
                    subject: subjectOf(user),
                    effective: sorted(
                        await reader.effectiveCapabilities(user.id),
                    ),
                    managed: CAPABILITIES.filter((capability) =>
                        members.get(capability)?.has(user.id),
                    ),
                });
            }
            return { entries, hasMore: page.length > max };
        },

        getAccess(subjectId: string) {
            return reader.access(subjectId);
        },

        async changeAccess(
            subjectId: string,
            change: AccessChange,
        ): Promise<AccessChangeResult> {
            const before = await reader.access(subjectId);
            if (!before) {
                throw new IdentityProviderError(
                    "not_found",
                    "Not found at the identity provider",
                    404,
                );
            }
            const applied: AccessChange = { add: [], remove: [] };
            const failed: AccessChangeResult["failed"] = [];
            const steps: { capability: Capability; add: boolean }[] = [
                ...change.add
                    .filter(
                        (capability) => !before.managed.includes(capability),
                    )
                    .map((capability) => ({ capability, add: true })),
                ...change.remove
                    .filter((capability) => before.managed.includes(capability))
                    .map((capability) => ({ capability, add: false })),
            ];
            for (const { capability, add } of steps) {
                const path = adminPath`/users/${subjectId}/groups/${groups[capability]}`;
                try {
                    if (add) await http.put(path);
                    else await http.delete(path);
                    (add ? applied.add : applied.remove).push(capability);
                } catch (error) {
                    if (!(error instanceof IdentityProviderError)) throw error;
                    if (
                        applied.add.length + applied.remove.length === 0 &&
                        (error.kind === "forbidden" ||
                            error.kind === "unauthorized")
                    ) {
                        throw error;
                    }
                    failed.push({ capability, error: error.kind });
                }
            }
            const after = await reader.access(subjectId);
            if (!after) {
                throw new IdentityProviderError(
                    "not_found",
                    "The subject disappeared during the change",
                    404,
                );
            }
            const stillEffective = after.inherited.filter(
                ({ capability }) =>
                    change.remove.includes(capability) &&
                    after.effective.includes(capability),
            );
            const changed = applied.add.length + applied.remove.length > 0;
            return {
                status:
                    failed.length > 0
                        ? "partial"
                        : changed
                          ? "applied"
                          : "noop",
                applied,
                failed,
                stillEffective,
                after,
            };
        },

        async revokeSessions(subjectId: string) {
            await http.post(adminPath`/users/${subjectId}/logout`);
        },
    };
}
