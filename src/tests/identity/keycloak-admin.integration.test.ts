/**
 * The Keycloak access-management adapter and access verifier against a
 * real realm: where an inherited capability comes from, convergent
 * repeated changes, a change that fails half-way reporting only what was
 * applied, paging, and the verifier's view of active, disabled and deleted
 * people. The adapter runs with an administrator's own token (only
 * `manage-users`, `view-clients`), the verifier with its service client
 * (`view-users`, `view-clients`).
 *
 * Opt-in: `KEYCLOAK_TEST_ISSUER`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityProviderError } from "@/lib/identity/ports";
import { keycloakAdmin } from "@/lib/identity/providers/keycloak/admin";
import type { KeycloakConfig } from "@/lib/identity/providers/keycloak/config";
import {
    adminPath,
    createKeycloakHttp,
} from "@/lib/identity/providers/keycloak/http";
import { keycloakVerifier } from "@/lib/identity/providers/keycloak/verifier";
import {
    bootstrapCredentials,
    keycloakTestBase,
    provisionTestRealm,
    type TestRealm,
} from "@/tests/identity/keycloak-fixture";

const describeWithKeycloak = keycloakTestBase() ? describe : describe.skip;

describeWithKeycloak("Keycloak access adapter", () => {
    let realm: TestRealm;
    let config: KeycloakConfig;
    let adminToken: () => Promise<string>;

    function id(username: string): string {
        const found = realm.people[username]?.id;
        if (!found) throw new Error(`no person ${username}`);
        return found;
    }

    beforeAll(async () => {
        realm = await provisionTestRealm("adapter", {
            boss: ["use", "access.manage"],
            ann: ["use"],
            sub: ["use"],
            other: ["use"],
            comp: ["use"],
            gone: ["use"],
            off: ["use"],
        });
        for (let index = 0; index < 4; index++) {
            await realm.createPerson(`page${index}`, []);
        }
        config = {
            baseUrl: bootstrapCredentials().baseUrl,
            realm: realm.realm,
            rolesClient: "chatterbox",
            mcpAudience: "chatterbox-mcp",
            groups: realm.groupIds,
            verifier: {
                clientId: "chatterbox-verifier",
                clientSecret: realm.secrets["chatterbox-verifier"] ?? "",
            },
        };
        adminToken = async () =>
            (
                await realm.passwordToken(
                    "chatterbox",
                    realm.people.boss ?? (undefined as never),
                )
            ).access_token;

        const { http } = realm.admin;
        const [web] = await http.get<{ id: string }[]>(adminPath`/clients`, {
            clientId: "chatterbox",
        });
        const webId = web?.id ?? "";
        const role = (name: string) =>
            http.get<{ id: string; name: string }>(
                adminPath`/clients/${webId}/roles/${name}`,
            );

        await http.post(
            adminPath`/groups/${realm.groupIds["org.curate"]}/children`,
            {
                name: "curators-subgroup",
            },
        );
        const children = await http.get<{ id: string; name: string }[]>(
            adminPath`/groups/${realm.groupIds["org.curate"]}/children`,
        );
        const subgroup = children.find((g) => g.name === "curators-subgroup");
        await http.put(
            adminPath`/users/${id("sub")}/groups/${subgroup?.id ?? ""}`,
        );

        await http.post(adminPath`/groups`, { name: "legacy-curators" });
        const [legacy] = await http.get<{ id: string; name: string }[]>(
            adminPath`/groups`,
            { search: "legacy-curators", exact: "true" },
        );
        await http.post(
            adminPath`/groups/${legacy?.id ?? ""}/role-mappings/clients/${webId}`,
            [await role("org.curate")],
        );
        await http.put(
            adminPath`/users/${id("other")}/groups/${legacy?.id ?? ""}`,
        );

        await http.post(adminPath`/roles`, { name: "staff" });
        await http.post(adminPath`/roles/staff/composites`, [
            await role("access.manage"),
        ]);
        const staff = await http.get<{ id: string; name: string }>(
            adminPath`/roles/staff`,
        );
        await http.post(adminPath`/users/${id("comp")}/role-mappings/realm`, [
            staff,
        ]);
    }, 180_000);

    afterAll(async () => {
        await realm?.dispose();
    }, 30_000);

    it("tells where an inherited capability comes from", async () => {
        const port = keycloakAdmin(config, adminToken);
        expect((await port.getAccess(id("sub")))?.inherited).toEqual([
            { capability: "org.curate", sources: ["parent-group"] },
        ]);
        expect((await port.getAccess(id("other")))?.inherited).toEqual([
            { capability: "org.curate", sources: ["other-group"] },
        ]);
        expect((await port.getAccess(id("comp")))?.inherited).toEqual([
            { capability: "access.manage", sources: ["composite"] },
        ]);
        const ann = await port.getAccess(id("ann"));
        expect(ann).toMatchObject({
            effective: ["use"],
            managed: ["use"],
            inherited: [],
        });
        expect(
            await port.getAccess("00000000-0000-4000-8000-000000000000"),
        ).toBe(null);
    });

    it("reports a removal that leaves the capability effective", async () => {
        const port = keycloakAdmin(config, adminToken);
        await realm.admin.http.put(
            adminPath`/users/${id("other")}/groups/${realm.groupIds["org.curate"]}`,
        );
        const result = await port.changeAccess(id("other"), {
            add: [],
            remove: ["org.curate"],
        });
        expect(result.status).toBe("applied");
        expect(result.applied.remove).toEqual(["org.curate"]);
        expect(result.stillEffective).toEqual([
            { capability: "org.curate", sources: ["other-group"] },
        ]);
        expect(result.after.effective).toContain("org.curate");
    });

    it("converges when a change is repeated", async () => {
        const port = keycloakAdmin(config, adminToken);
        const first = await port.changeAccess(id("ann"), {
            add: ["org.curate"],
            remove: [],
        });
        expect(first.status).toBe("applied");
        const second = await port.changeAccess(id("ann"), {
            add: ["org.curate"],
            remove: [],
        });
        expect(second.status).toBe("noop");
        expect(second.after.revision).toBe(first.after.revision);
    });

    it("reports only what was applied when a change fails half-way", async () => {
        const real = createKeycloakHttp({
            baseUrl: config.baseUrl,
            realm: config.realm,
            token: adminToken,
        });
        const adminGroup = realm.groupIds["access.manage"];
        const broken = keycloakAdmin(config, adminToken, {
            ...real,
            put: async (path, body) => {
                if (path.endsWith(`/groups/${adminGroup}`)) {
                    throw new IdentityProviderError(
                        "unavailable",
                        "injected outage",
                        503,
                    );
                }
                return real.put(path, body);
            },
        });
        const result = await broken.changeAccess(id("ann"), {
            add: ["access.manage"],
            remove: ["org.curate"],
        });
        expect(result.status).toBe("partial");
        expect(result.applied).toEqual({ add: [], remove: ["org.curate"] });
        expect(result.failed).toEqual([
            { capability: "access.manage", error: "unavailable" },
        ]);
        expect(result.after.effective).toEqual(["use"]);
    });

    it("pages through people", async () => {
        const port = keycloakAdmin(config, adminToken);
        const first = await port.listAccess({
            search: "page",
            first: 0,
            max: 3,
        });
        expect(first.entries).toHaveLength(3);
        expect(first.hasMore).toBe(true);
        const rest = await port.listAccess({
            search: "page",
            first: 3,
            max: 3,
        });
        expect(rest.entries).toHaveLength(1);
        expect(rest.hasMore).toBe(false);
        expect(
            [...first.entries, ...rest.entries].every(
                (entry) => entry.effective.length === 0,
            ),
        ).toBe(true);
    });

    it("refuses an administrator without manage-users at the provider", async () => {
        const weak = keycloakAdmin(
            config,
            async () =>
                (
                    await realm.passwordToken(
                        "chatterbox",
                        realm.people.ann ?? (undefined as never),
                    )
                ).access_token,
        );
        await expect(
            weak.changeAccess(id("off"), { add: ["org.curate"], remove: [] }),
        ).rejects.toMatchObject({ kind: "forbidden" });
        await expect(weak.revokeSessions(id("off"))).rejects.toBeInstanceOf(
            IdentityProviderError,
        );
    });

    it("lets the verifier see active, disabled and deleted people, and nothing more", async () => {
        const verifier = keycloakVerifier(config);
        const ann = await verifier.verify(id("ann"));
        expect(ann.status).toBe("active");

        await realm.admin.http.put(adminPath`/users/${id("off")}`, {
            enabled: false,
        });
        expect(await verifier.verify(id("off"))).toEqual({
            status: "disabled",
        });

        await realm.admin.http.delete(adminPath`/users/${id("gone")}`);
        expect(await verifier.verify(id("gone"))).toEqual({
            status: "missing",
        });

        const verifierToken = (await realm.clientToken("chatterbox-verifier"))
            .access_token;
        const write = await fetch(
            `${config.baseUrl}/admin/realms/${realm.realm}/users/${id("ann")}/groups/${realm.groupIds["access.manage"]}`,
            {
                method: "PUT",
                headers: { authorization: `Bearer ${verifierToken}` },
            },
        );
        expect(write.status).toBe(403);
    });

    it("reports an unreachable provider as unavailable", async () => {
        const verifier = keycloakVerifier({
            ...config,
            baseUrl: "http://127.0.0.1:9",
        });
        await expect(verifier.verify(id("ann"))).rejects.toMatchObject({
            kind: "unavailable",
        });
    });
});
