/** Disposable local Keycloak realms imported from a static test fixture. */
import { randomBytes } from "node:crypto";
import type { Capability } from "@/lib/authz/catalog";
import {
    adminPath,
    createKeycloakHttp,
    type KeycloakHttp,
} from "@/lib/identity/providers/keycloak/http";
import seed from "./fixtures/realm.json";

interface BootstrapCredentials {
    baseUrl: string;
    authRealm: string;
    clientId: string;
    username: string;
    password: string;
}

/** The Keycloak base URL of the opt-in tests, or null when they are off. */
export function keycloakTestBase(): string | null {
    const issuer = process.env.KEYCLOAK_TEST_ISSUER?.trim();
    if (!issuer) return null;
    const url = new URL(issuer);
    if (
        !["localhost", "127.0.0.1", "[::1]", "docker", "keycloak"].includes(
            url.hostname,
        )
    ) {
        throw new Error(
            "Keycloak integration tests require a disposable local server",
        );
    }
    return `${url.origin}${url.pathname.replace(/\/realms\/.*$/, "")}`;
}

export function bootstrapCredentials(): BootstrapCredentials {
    const baseUrl = keycloakTestBase();
    if (!baseUrl) throw new Error("KEYCLOAK_TEST_ISSUER is not set");
    return {
        baseUrl,
        authRealm: "master",
        clientId: "admin-cli",
        username: "admin",
        password: process.env.KEYCLOAK_TEST_ADMIN_PASSWORD ?? "admin",
    };
}

export const TEST_APP_URL = "http://localhost:3000";
export const MCP_RESOURCE = "https://chatterbox.example.com/api/mcp";
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** A person of the test realm. */
export interface TestPerson {
    username: string;
    password: string;
    email: string;
    id: string;
}

export interface TestRealm {
    realm: string;
    issuer: string;
    admin: { http: KeycloakHttp };
    groupIds: Record<Capability, string>;
    secrets: Record<string, string>;
    people: Record<string, TestPerson>;
    createPerson(
        username: string,
        capabilities: Capability[],
        options?: { emailVerified?: boolean },
    ): Promise<TestPerson>;
    passwordToken(
        clientId: string,
        person: TestPerson,
        extra?: Record<string, string>,
    ): Promise<TokenSet>;
    clientToken(clientId: string): Promise<TokenSet>;
    dispose(): Promise<void>;
}

export interface TokenSet {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
}

/** Options of {@link provisionTestRealm}. */
export interface ProvisionOptions {
    /** A fixed realm name (replaces an existing realm of that name). */
    realmName?: string;
    /** Client secrets to set instead of Keycloak's generated ones. */
    secrets?: Record<string, string>;
}

async function masterToken(credentials: BootstrapCredentials): Promise<string> {
    const response = await fetch(
        `${credentials.baseUrl}/realms/master/protocol/openid-connect/token`,
        {
            method: "POST",
            body: new URLSearchParams({
                grant_type: "password",
                client_id: "admin-cli",
                username: credentials.username ?? "admin",
                password: credentials.password ?? "admin",
            }),
        },
    );
    const body = (await response.json()) as { access_token: string };
    if (!response.ok || !body.access_token)
        throw new Error(`Test admin login failed (${response.status})`);
    return body.access_token;
}

async function deleteRealm(
    credentials: BootstrapCredentials,
    realm: string,
): Promise<void> {
    const response = await fetch(
        `${credentials.baseUrl}/admin/realms/${realm}`,
        {
            method: "DELETE",
            headers: {
                authorization: `Bearer ${await masterToken(credentials)}`,
            },
        },
    );
    if (!response.ok && response.status !== 404)
        throw new Error(`Test realm cleanup failed (${response.status})`);
}

/** Import a static realm into a disposable local Keycloak and return its handle. */
export async function provisionTestRealm(
    label: string,
    people: Record<string, Capability[]> = {},
    options: ProvisionOptions = {},
): Promise<TestRealm> {
    const credentials = bootstrapCredentials();
    const realm =
        options.realmName ?? `chb-${label}-${randomBytes(4).toString("hex")}`;
    if (!/^chb-[a-z0-9-]+$/.test(realm))
        throw new Error("Test realm names must start with chb-");
    if (options.realmName) await deleteRealm(credentials, realm);
    const representation = structuredClone(seed);
    representation.realm = realm;
    const imported = await fetch(`${credentials.baseUrl}/admin/realms`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${await masterToken(credentials)}`,
            "content-type": "application/json",
        },
        body: JSON.stringify(representation),
        signal: AbortSignal.timeout(30_000),
    });
    if (!imported.ok)
        throw new Error(`Test realm import failed (${imported.status})`);
    const http = createKeycloakHttp({
        baseUrl: credentials.baseUrl,
        realm,
        token: () => masterToken(credentials),
    });
    const admin = { http };
    const groupIds = {} as Record<Capability, string>;
    const names: Record<Capability, string> = {
        use: "chatterbox-users",
        "org.curate": "chatterbox-curators",
        "access.manage": "chatterbox-admins",
    };
    for (const [capability, name] of Object.entries(names)) {
        const found = await http.get<{ id: string; name: string }[]>(
            adminPath`/groups`,
            { search: name, exact: "true" },
        );
        const match = found.find((entry) => entry.name === name);
        if (!match) throw new Error(`group ${name} missing`);
        groupIds[capability as Capability] = match.id;
    }
    const secrets: Record<string, string> = {};
    for (const clientId of [
        "chatterbox",
        "chatterbox-verifier",
        "claude",
        "chatterbox-bot",
    ]) {
        const [client] = await http.get<{ id: string }[]>(adminPath`/clients`, {
            clientId,
        });
        if (!client) throw new Error(`client ${clientId} missing`);
        const wanted = options.secrets?.[clientId];
        if (wanted) {
            const current = await http.get<Record<string, unknown>>(
                adminPath`/clients/${client.id}`,
            );
            await http.put(adminPath`/clients/${client.id}`, {
                ...current,
                secret: wanted,
            });
        }
        const secret = await http.get<{ value: string }>(
            adminPath`/clients/${client.id}/client-secret`,
        );
        secrets[clientId] = secret.value;
    }

    const issuer = `${credentials.baseUrl}/realms/${realm}`;
    const tokenUrl = `${issuer}/protocol/openid-connect/token`;
    const requestToken = async (form: Record<string, string>) => {
        const response = await fetch(tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(form),
        });
        const body = (await response.json()) as TokenSet & {
            error_description?: string;
        };
        if (!response.ok) {
            throw new Error(
                `token request failed: ${response.status} ${body.error_description ?? ""}`,
            );
        }
        return body;
    };

    const handle: TestRealm = {
        realm,
        issuer,
        admin,
        groupIds,
        secrets,
        people: {},
        async createPerson(username, capabilities, options = {}) {
            const password = `${username}-password`;
            const email = `${username}@example.test`;
            await http.post(adminPath`/users`, {
                username,
                email,
                emailVerified: options.emailVerified ?? true,
                enabled: true,
                firstName: username,
                lastName: "Example",
                credentials: [
                    { type: "password", value: password, temporary: false },
                ],
            });
            const [created] = await http.get<{ id: string }[]>(
                adminPath`/users`,
                { username, exact: "true" },
            );
            if (!created) throw new Error(`user ${username} missing`);
            for (const capability of capabilities) {
                await http.put(
                    adminPath`/users/${created.id}/groups/${groupIds[capability]}`,
                );
            }
            const person = { username, password, email, id: created.id };
            handle.people[username] = person;
            return person;
        },
        passwordToken(clientId, person, extra = {}) {
            return requestToken({
                grant_type: "password",
                client_id: clientId,
                ...(secrets[clientId]
                    ? { client_secret: secrets[clientId] }
                    : {}),
                username: person.username,
                password: person.password,
                scope: "openid",
                ...extra,
            });
        },
        clientToken(clientId) {
            return requestToken({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: secrets[clientId] ?? "",
            });
        },
        async dispose() {
            await deleteRealm(credentials, realm);
        },
    };
    for (const [username, capabilities] of Object.entries(people)) {
        await handle.createPerson(username, capabilities);
    }
    return handle;
}
