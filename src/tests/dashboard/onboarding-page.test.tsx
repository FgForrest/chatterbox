import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "@/app/(app)/dashboard/page";
import {
    aiEnhancements,
    plaudConnections,
    recordings,
    transcriptions,
} from "@/db/schema";
import { appChromeConfig } from "@/lib/settings/app-chrome";

const {
    state,
    readiness,
    capabilities,
    review,
    select,
    settings,
    orgAccount,
    connection,
} = vi.hoisted(() => ({
    state: {
        completed: true,
        connection: { invalidatedAt: null as Date | null },
        organization: false,
    },
    readiness: vi.fn(),
    capabilities: vi.fn(),
    review: vi.fn(),
    select: vi.fn(),
    settings: vi.fn(),
    orgAccount: vi.fn(),
    connection: vi.fn(),
}));
vi.mock("@/components/dashboard/workstation", () => ({
    Workstation: () => null,
}));
vi.mock("@/db", () => ({ db: { select } }));
vi.mock("@/lib/auth-server", () => ({
    requireAuth: async () => ({
        user: { id: "viewer", email: "viewer@example.test" },
    }),
    getSessionActor: async () => null,
}));
vi.mock("@/lib/access/service", () => ({
    accessManagementAvailable: () => false,
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: async () => false,
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string) => value,
}));
vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false, SELF_HOST_MODE: "local" },
}));
vi.mock("@/lib/folder-exports/configurations", () => ({
    exportProvidersAvailability: () => ({}),
}));
vi.mock("@/lib/folders/folders", () => ({
    listFolderOrganization: async () => ({ folders: [], assignments: [] }),
}));
vi.mock("@/lib/hosted/admin/guard", () => ({ isAdminEmail: () => false }));
vi.mock("@/lib/learn/llm-input", () => ({
    confirmedOverlays: async () => new Map(),
}));
vi.mock("@/lib/learn/pending", () => ({ recordingsNeedingReview: review }));
vi.mock("@/lib/learn/render", () => ({ readTextOf: () => null }));
vi.mock("@/lib/mail/config", () => ({ isMailEnabled: () => false }));
vi.mock("@/lib/settings/user-settings", () => ({ getUserSettings: settings }));
vi.mock("@/lib/settings/plaud-connection", () => ({
    getPlaudConnection: connection,
}));
vi.mock("@/lib/mail/list", () => ({ loadMailListRows: async () => [] }));
vi.mock("@/lib/onboarding/readiness", () => ({
    loadOnboardingReadiness: readiness,
    loadOnboardingCapabilities: capabilities,
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => null,
    isOrgAccount: orgAccount,
}));
vi.mock("@/lib/sharing/access", () => ({ sharedRecordingCondition: vi.fn() }));

describe("layout onboarding seed", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.completed = true;
        state.organization = false;
        settings.mockImplementation(async () => ({
            onboardingCompleted: state.completed,
        }));
        orgAccount.mockImplementation(async () => state.organization);
        connection.mockImplementation(async () => state.connection);
        state.connection = { invalidatedAt: null };
        capabilities.mockResolvedValue({
            audience: "single-user",
            mailAvailable: false,
        });
        readiness.mockResolvedValue({ plaud: "connected" });
        review.mockResolvedValue(new Set());
        select.mockImplementation(() => ({
            from(table: unknown) {
                const rows =
                    table === plaudConnections ? [state.connection] : [];
                expect([
                    recordings,
                    transcriptions,
                    aiEnhancements,
                    plaudConnections,
                ]).toContain(table);
                const query = Object.assign(Promise.resolve(rows), {
                    innerJoin: () => query,
                    where: () => query,
                    orderBy: async () => rows,
                    limit: async () => rows,
                });
                return query;
            },
        }));
    });

    it("does not load readiness after onboarding is completed", async () => {
        const config = await appChromeConfig();
        expect(config.onboardingReadiness).toBeUndefined();
        expect(readiness).not.toHaveBeenCalled();
        expect(connection).not.toHaveBeenCalled();
        expect(capabilities).toHaveBeenCalledExactlyOnceWith("viewer", {
            id: null,
            isAccount: false,
        });
    });

    it("seeds incomplete onboarding with the shared Plaud connection status", async () => {
        state.completed = false;
        state.connection = { invalidatedAt: new Date() };
        const config = await appChromeConfig();
        expect(config.onboardingReadiness).toEqual({ plaud: "connected" });
        expect(readiness).toHaveBeenCalledExactlyOnceWith(
            "viewer",
            { audience: "single-user", mailAvailable: false },
            { plaudConnection: state.connection },
        );
        expect(connection).toHaveBeenCalledExactlyOnceWith("viewer");
        expect(settings).toHaveBeenCalledExactlyOnceWith("viewer");
        expect(orgAccount).toHaveBeenCalledExactlyOnceWith("viewer");
        expect(select).not.toHaveBeenCalled();
    });

    it("seeds a new account when no settings row exists", async () => {
        settings.mockResolvedValue(undefined);
        const config = await appChromeConfig();
        expect(config.initialSettings.onboardingCompleted).toBe(false);
        expect(config.onboardingReadiness).toEqual({ plaud: "connected" });
        expect(readiness).toHaveBeenCalledOnce();
    });

    it("passes the Organization audience and Recorder filter to the shared provider", async () => {
        state.organization = true;
        capabilities.mockResolvedValue({
            audience: "organization-account",
            mailAvailable: false,
        });
        const config = await appChromeConfig();
        expect(config.isOrgAccount).toBe(true);
        expect(config.onboardingCapabilities.audience).toBe(
            "organization-account",
        );
        expect(config.mailEnabled).toBe(false);
        expect(capabilities).toHaveBeenCalledExactlyOnceWith("viewer", {
            id: null,
            isAccount: true,
        });
    });

    it("starts readiness alongside the remaining dashboard work", async () => {
        state.completed = false;
        let finishReadiness: (snapshot: { plaud: string }) => void = () => {};
        readiness.mockReturnValue(
            new Promise<{ plaud: string }>((resolve) => {
                finishReadiness = resolve;
            }),
        );
        let finishReview: (ids: Set<string>) => void = () => {};
        let startedReview: () => void = () => {};
        const reviewStarted = new Promise<void>((resolve) => {
            startedReview = resolve;
        });
        review.mockImplementation(() => {
            startedReview();
            return new Promise<Set<string>>((resolve) => {
                finishReview = resolve;
            });
        });
        const layoutConfig = appChromeConfig();
        const render = DashboardPage();
        await reviewStarted;
        expect(readiness).toHaveBeenCalledOnce();
        finishReadiness({ plaud: "connected" });
        finishReview(new Set());
        await Promise.all([layoutConfig, render]);
    });
});
