// @vitest-environment jsdom

/**
 * Settings shows Access only to an administrator of access: the server
 * decides it (`accessManagementAvailable`) and the nav builds from that.
 */

import {
    act,
    cleanup,
    render,
    renderHook,
    screen,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
    AUTHZ_MODE: "idp" as "idp" | "local",
    IDENTITY_PROVIDER: "keycloak",
    OIDC_ISSUER_URL: "https://id.example.com/realms/acme",
    OIDC_CLIENT_ID: "chatterbox",
    KEYCLOAK_GROUP_USE_ID: "00000000-0000-4000-8000-000000000001",
    KEYCLOAK_GROUP_CURATE_ID: "00000000-0000-4000-8000-000000000002",
    KEYCLOAK_GROUP_ACCESS_MANAGE_ID: "00000000-0000-4000-8000-000000000003" as
        | string
        | undefined,
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("next-intl", () => ({
    useExtracted: () => (source: string, values?: Record<string, string>) =>
        Object.entries(values ?? {}).reduce(
            (message, [key, value]) => message.replaceAll(`{${key}}`, value),
            source,
        ),
}));

afterEach(() => {
    cleanup();
    localStorage.clear();
    window.history.replaceState(null, "", "/settings");
});

import { SettingsContent } from "@/components/settings-content";
import {
    buildSettingsNav,
    buildSettingsNavGroups,
    SETTINGS_STORAGE_KEY,
} from "@/components/settings-nav-config";
import { SettingsNavMobile } from "@/components/settings-nav-mobile";
import { SettingsNavSidebar } from "@/components/settings-nav-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useSettingsNav } from "@/hooks/use-settings-nav";
import { accessManagementAvailable } from "@/lib/access/service";
import type { Capability } from "@/lib/authz/catalog";
import type { ActorContext } from "@/lib/authz/model";

function person(...capabilities: Capability[]): ActorContext {
    return {
        kind: "user",
        actorId: "u1",
        issuer: "https://id.example.com/realms/acme",
        subject: "s1",
        capabilities: new Set(capabilities),
        clientId: "chatterbox",
        clientPermissions: new Set(),
        verifiedAt: new Date(),
    };
}

function showsAccess(actor: ActorContext | null): boolean {
    return buildSettingsNav({
        isHosted: false,
        accessManagement: accessManagementAvailable(actor),
    }).some((item) => item.id === "access");
}

describe("Settings -> Access", () => {
    it("is shown to an administrator of access", () => {
        expect(showsAccess(person("use", "access.manage"))).toBe(true);
    });

    it("is hidden from everyone else", () => {
        expect(showsAccess(null)).toBe(false);
        expect(showsAccess(person("use"))).toBe(false);
        expect(showsAccess(person("use", "org.curate"))).toBe(false);
        expect(showsAccess(person("access.manage"))).toBe(false);
        expect(
            showsAccess({
                ...person("use", "access.manage"),
                kind: "service",
            }),
        ).toBe(false);
    });

    it("is hidden without the managed groups or in local mode", () => {
        mockEnv.KEYCLOAK_GROUP_ACCESS_MANAGE_ID = undefined;
        expect(showsAccess(person("use", "access.manage"))).toBe(false);
        mockEnv.KEYCLOAK_GROUP_ACCESS_MANAGE_ID =
            "00000000-0000-4000-8000-000000000003";
        mockEnv.AUTHZ_MODE = "local";
        expect(showsAccess(person("use", "access.manage"))).toBe(false);
        mockEnv.AUTHZ_MODE = "idp";
    });
});

describe("Settings -> Meeting Recorder", () => {
    it.each([
        false,
        true,
    ])("hides the section for the Organization account (hosted: %s)", (isHosted) => {
        expect(
            buildSettingsNav({ isHosted, isOrgAccount: true }).some(
                (item) => item.id === "recorder",
            ),
        ).toBe(false);
        expect(
            buildSettingsNav({ isHosted, isOrgAccount: false }).some(
                (item) => item.id === "recorder",
            ),
        ).toBe(true);
    });
});

describe("Organization account personal settings", () => {
    const personalSections = [
        "plaud-account",
        "google-account",
        "recorder",
        "mail",
    ] as const;
    it.each([
        false,
        true,
    ])("filters every navigation group in hosted mode %s", (isHosted) => {
        const options = { isHosted, isOrgAccount: true, mailEnabled: true };
        const groups = buildSettingsNavGroups(options);
        const navigation = buildSettingsNav(options).map((item) => item.id);
        for (const section of personalSections)
            expect(navigation).not.toContain(section);
        expect(
            groups.flatMap((group) => group.items).map((item) => item.id),
        ).toEqual(navigation);
        expect(navigation).toContain("providers");
        expect(navigation).toContain("profiles");
    });
    it.each(
        personalSections,
    )("does not render direct content for %s", (activeSection) => {
        expect(
            SettingsContent({
                activeSection,
                isOrgAccount: true,
                mailEnabled: true,
            }),
        ).toBeNull();
    });
    it.each(
        personalSections,
    )("rejects hashes, saved selections and direct navigation to %s", (section) => {
        window.location.hash = section;
        localStorage.setItem(SETTINGS_STORAGE_KEY, section);
        const { result } = renderHook(() =>
            useSettingsNav(true, vi.fn(), false, true, false, true),
        );
        expect(result.current.activeSection).toBe("providers");
        act(() => result.current.setActiveSection(section));
        expect(result.current.activeSection).toBe("providers");
        expect(window.location.hash).toBe("#providers");
        expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe("providers");
    });
    it("drops an active personal section when the audience changes", () => {
        const { result, rerender } = renderHook(
            ({ orgAccount }) =>
                useSettingsNav(false, vi.fn(), false, true, false, orgAccount),
            { initialProps: { orgAccount: false } },
        );
        act(() => result.current.setActiveSection("plaud-account"));
        expect(result.current.activeSection).toBe("plaud-account");
        rerender({ orgAccount: true });
        expect(result.current.activeSection).toBe("providers");
    });
    it("filters the mobile picker and sidebar", () => {
        window.matchMedia = vi.fn().mockReturnValue({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });
        render(
            createElement(
                SidebarProvider,
                {},
                createElement(SettingsNavMobile, {
                    activeSection: "providers",
                    onSectionChange: vi.fn(),
                    isHosted: false,
                    isOrgAccount: true,
                    mailEnabled: true,
                }),
                createElement(SettingsNavSidebar, {
                    activeSection: "providers",
                    keyboardSelectedIndex: 0,
                    onSectionChange: vi.fn(),
                    isHosted: false,
                    isOrgAccount: true,
                    mailEnabled: true,
                }),
            ),
        );
        for (const name of [
            "Plaud Account",
            "Google Account",
            "Meeting Recorder",
            "Mail",
        ])
            expect(
                screen.queryByRole("button", { name: `${name} settings` }),
            ).toBeNull();
        expect(
            screen.getByRole("button", { name: "Profiles settings" }),
        ).toBeTruthy();
    });
});
