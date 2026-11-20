import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sniffAudio } from "@/lib/audio/sniff";
import {
    decodeAccessTokenExpiry,
    plaudRefreshUserToken,
} from "@/lib/plaud/auth";
import {
    isReady,
    parseTranscript,
    selectContentItems,
} from "@/lib/plaud/content";
import { plaudFetch } from "@/lib/plaud/fetch";
import { isValidPlaudApiUrl, PLAUD_USER_AGENT } from "@/lib/plaud/servers";
import {
    audioExtension,
    buildRecordingStagingPath,
} from "@/lib/recordings/filename";

// Mock env so importing PlaudClient (which transitively loads env via
// `proxy.ts`) doesn't trip the DATABASE_URL/ENCRYPTION_KEY runtime checks
// when running `pnpm test` without a populated .env.
const mockEnv = vi.hoisted(() => ({
    WEBSHARE_API_KEY: process.env.WEBSHARE_API_KEY,
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

import { DEFAULT_PLAUD_API_BASE, PlaudClient } from "../lib/plaud/client";

const bearerToken = process.env.PLAUD_BEARER_TOKEN;
const refreshToken = process.env.PLAUD_REFRESH_TOKEN;
const apiBase = process.env.PLAUD_API_BASE;
const hasToken = typeof bearerToken === "string" && bearerToken.length > 0;

if (!hasToken) {
    console.warn(
        "Skipping PlaudClient integration tests: PLAUD_BEARER_TOKEN not set.",
    );
}

const describeIntegration = hasToken ? describe : describe.skip;

async function readPlaud<T>(read: () => Promise<T>): Promise<T> {
    try {
        return await read();
    } catch {
        throw new Error("A read-only Plaud API request failed");
    }
}

it.skipIf(!refreshToken)(
    "refreshes Plaud access without extending the sign-in",
    async () => {
        if (!refreshToken) throw new Error("PLAUD_REFRESH_TOKEN is required");
        const base = apiBase ?? DEFAULT_PLAUD_API_BASE;
        const previousEnd = decodeAccessTokenExpiry(refreshToken)?.getTime();
        if (previousEnd === undefined) {
            throw new Error("The refresh token has no readable session expiry");
        }
        const tokens = await readPlaud(() =>
            plaudRefreshUserToken(refreshToken, base),
        );
        const nextEnd = tokens.sessionExpiresAt?.getTime();
        if (nextEnd === undefined) {
            throw new Error("Plaud did not return a readable session expiry");
        }
        expect(nextEnd).toBeLessThanOrEqual(previousEnd);

        const response = await readPlaud(() =>
            plaudFetch(`${base}/device/list`, {
                headers: {
                    Authorization: `Bearer ${tokens.accessToken}`,
                    "User-Agent": PLAUD_USER_AGENT,
                },
            }),
        );
        expect(response.ok).toBe(true);
        const body = await readPlaud(
            async () => (await response.json()) as { status?: number },
        );
        expect(body.status).toBe(0);
    },
);

describeIntegration("PlaudClient (integration)", () => {
    let client: PlaudClient;
    let restoreWarnings: (() => void) | undefined;

    beforeAll(() => {
        if (!bearerToken) throw new Error("PLAUD_BEARER_TOKEN is required");
        if (apiBase && !isValidPlaudApiUrl(apiBase)) {
            throw new Error("PLAUD_API_BASE must be an HTTPS Plaud API URL");
        }
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
        restoreWarnings = () => warnings.mockRestore();
        client = new PlaudClient(bearerToken, apiBase);
    });

    afterAll(() => restoreWarnings?.());

    it("confirms the Plaud API connection is healthy", async () => {
        const result = await client.testConnection();
        expect(result).toBe(true);
    });

    it("lists devices with a success response", async () => {
        const response = await readPlaud(() => client.listDevices());
        expect(response.status).toBe(0);
        expect(Array.isArray(response.data_devices)).toBe(true);
    });

    it("fetches the latest recordings payload", async () => {
        const response = await readPlaud(() =>
            client.getRecordings(0, 5, 0, "edit_time", true),
        );
        expect(response.status).toBe(0);
        expect(Array.isArray(response.data_file_list)).toBe(true);
        expect(typeof response.data_file_total).toBe("number");
    });

    it("lists migrated ids and downloads the newest recording in its sniffed format", async ({
        skip,
    }) => {
        const first = await readPlaud(() =>
            client.getRecordings(0, 1, 0, "start_time"),
        );
        if (!client.usingPlaudV4) return skip();
        const { data_file_list: recordings } = await readPlaud(() =>
            client.getRecordings(0, first.data_file_total, 0, "start_time"),
        );
        expect(recordings.length).toBeGreaterThan(0);
        expect(
            recordings.every(
                ({ id }) => id.length > 0 && !id.startsWith("of_"),
            ),
        ).toBe(true);
        const nativeIds = recordings.filter(({ id }) =>
            id.startsWith("f_"),
        ).length;
        const newest = await readPlaud(() =>
            client.hydrateRecording(recordings[0]),
        );
        const audio = await readPlaud(() =>
            client.downloadRecording(newest.id, false),
        );
        expect(audio.length).toBeGreaterThan(0);
        const { container, extension } = sniffAudio(audio);
        expect(container).not.toBe("unknown");
        const key = buildRecordingStagingPath(
            "test-owner",
            "test-recording",
            extension,
        );
        expect(audioExtension(key)).toBe(extension);
        console.info(
            `Plaud v4 recordings=${recordings.length} nativeIds=${nativeIds} legacyIds=${recordings.length - nativeIds} audioBytes=${audio.length} format=${extension}`,
        );
    }, 120_000);

    it("parses the newest ready migrated transcript", async ({ skip }) => {
        const first = await readPlaud(() =>
            client.getRecordings(0, 1, 0, "start_time"),
        );
        if (!client.usingPlaudV4) return skip();
        const { data_file_list: recordings } = await readPlaud(() =>
            client.getRecordings(0, first.data_file_total, 0, "start_time"),
        );
        for (const recording of recordings) {
            const hydrated = await readPlaud(() =>
                client.hydrateRecording(recording),
            );
            if (!hydrated.is_trans) continue;
            const detail = await readPlaud(() =>
                client.getFileDetail(recording.id),
            );
            const { transcript } = selectContentItems(detail);
            expect(isReady(transcript)).toBe(true);
            if (!transcript?.data_link)
                throw new Error("The ready transcript has no URL");
            const link = transcript.data_link;
            const body = await readPlaud(() => client.fetchContentLink(link));
            const parsed = parseTranscript(body);
            expect(parsed.text.trim().length).toBeGreaterThan(0);
            console.info(
                `Plaud v4 transcripts=1 characters=${parsed.text.trim().length}`,
            );
            return;
        }
        return skip();
    }, 120_000);
});
