import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "@/app/(app)/dashboard/page";
import {
    aiEnhancements,
    plaudConnections,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";

const { state, readiness, capabilities, review, select } = vi.hoisted(() => ({
    state: {
        completed: true,
        connection: { invalidatedAt: null as Date | null },
    },
    readiness: vi.fn(),
    capabilities: vi.fn(),
    review: vi.fn(),
    select: vi.fn(),
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
vi.mock("@/lib/mail/list", () => ({ loadMailListRows: async () => [] }));
vi.mock("@/lib/onboarding/readiness", () => ({
    loadOnboardingReadiness: readiness,
    loadOnboardingCapabilities: capabilities,
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => null,
    isOrgAccount: async () => false,
}));
vi.mock("@/lib/sharing/access", () => ({ sharedRecordingCondition: vi.fn() }));

describe("dashboard onboarding seed", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.completed = true;
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
                    table === userSettings
                        ? [{ onboardingCompleted: state.completed }]
                        : table === plaudConnections
                          ? [state.connection]
                          : [];
                expect([
                    recordings,
                    transcriptions,
                    aiEnhancements,
                    userSettings,
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
        const page = await DashboardPage();
        expect(page.props.onboardingReadiness).toBeUndefined();
        expect(readiness).not.toHaveBeenCalled();
        expect(capabilities).toHaveBeenCalledExactlyOnceWith("viewer", {
            id: null,
            isAccount: false,
        });
    });

    it("seeds incomplete onboarding with the Plaud row already read by the dashboard", async () => {
        state.completed = false;
        state.connection = { invalidatedAt: new Date() };
        const page = await DashboardPage();
        expect(page.props.onboardingReadiness).toEqual({ plaud: "connected" });
        expect(readiness).toHaveBeenCalledExactlyOnceWith(
            "viewer",
            { audience: "single-user", mailAvailable: false },
            { plaudConnection: state.connection },
        );
        expect(select).toHaveBeenCalledTimes(5);
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
        const render = DashboardPage();
        await reviewStarted;
        expect(readiness).toHaveBeenCalledOnce();
        finishReadiness({ plaud: "connected" });
        finishReview(new Set());
        await render;
    });
});
