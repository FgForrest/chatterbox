import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    session: vi.fn(async () => ({ user: { id: "caller" } })),
    access: vi.fn(async () => ({
        agenda: { id: "agenda", meetingItemId: "meeting" },
    })),
    redirect: vi.fn<() => Promise<string | null>>(async () => null),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({ requireApiSession: h.session }));
vi.mock("@/lib/meetings/access", () => ({
    requireMeetingAccess: h.access,
    meetingRecordingRedirect: h.redirect,
}));

import { GET } from "@/app/meetings/[id]/route";

beforeEach(() => {
    vi.clearAllMocks();
    h.redirect.mockResolvedValue(null);
});

it.each([
    null,
    "/dashboard?recording=recording&view=received",
])("redirects with a relative Location behind a proxy (%s)", async (destination) => {
    h.redirect.mockResolvedValue(destination);
    const response = await GET(
        new NextRequest("http://0.0.0.0:3000/meetings/meeting"),
        { params: Promise.resolve({ id: "meeting" }) },
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(
        destination ?? "/dashboard?meeting=meeting",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(h.access).toHaveBeenCalledWith("caller", "meeting");
});
