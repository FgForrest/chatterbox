import { describe, expect, it } from "vitest";
import type { DefaultProviderPointers } from "@/lib/ai/default-provider";
import {
    defaultProviderCandidates,
    type ResolutionStep,
} from "@/lib/ai/provider-resolution-order";

const empty = (): DefaultProviderPointers => ({
    transcription: null,
    summary: null,
    learn: null,
    topics: null,
    title: null,
});

describe.each([
    ["learn", true],
    ["topics", true],
    ["title", true],
    ["summary", false],
    ["transcription", false],
] as const)("%s default-provider order", (step, followsSummary) => {
    it("uses the member role pointer first", () => {
        const member = empty();
        const organization = empty();
        member[step] = "member-role";
        if (followsSummary) member.summary = "member-summary";
        organization[step] = "organization-role";
        if (followsSummary) organization.summary = "organization-summary";
        expect(defaultProviderCandidates(step, member, organization)).toEqual([
            { source: "member-role", providerId: "member-role" },
        ]);
    });

    it("uses the member summary pointer only for inheriting roles", () => {
        const member = empty();
        const organization = empty();
        member.summary = "member-summary";
        organization[step] = "organization-role";
        let expected = [
            { source: "organization-role", providerId: "organization-role" },
        ];
        if (followsSummary) {
            expected = [
                { source: "member-summary", providerId: "member-summary" },
            ];
        } else if (step === "summary") {
            expected = [
                { source: "member-role", providerId: "member-summary" },
            ];
        }
        expect(defaultProviderCandidates(step, member, organization)).toEqual(
            expected,
        );
    });

    it("uses the Organization role pointer before its summary pointer", () => {
        const organization = empty();
        organization[step] = "organization-role";
        if (followsSummary) organization.summary = "organization-summary";
        expect(defaultProviderCandidates(step, empty(), organization)).toEqual([
            { source: "organization-role", providerId: "organization-role" },
        ]);
    });

    it("uses the Organization summary pointer only for inheriting roles", () => {
        const organization = empty();
        organization.summary = "organization-summary";
        let expected: ReturnType<typeof defaultProviderCandidates> = [];
        if (followsSummary) {
            expected = [
                {
                    source: "organization-summary",
                    providerId: "organization-summary",
                },
            ];
        } else if (step === "summary") {
            expected = [
                {
                    source: "organization-role",
                    providerId: "organization-summary",
                },
            ];
        }
        expect(defaultProviderCandidates(step, empty(), organization)).toEqual(
            expected,
        );
    });

    it("skips Organization defaults when the member is unauthorized", () => {
        const organization = empty();
        organization[step] = "organization-role";
        expect(defaultProviderCandidates(step, empty(), null)).toEqual([]);
    });
});

describe("provider-default terminal behavior", () => {
    it("keeps an explicit disabled member pointer terminal instead of falling through", () => {
        const member = empty();
        const organization = empty();
        member.summary = "disabled-member-provider";
        organization.summary = "organization-provider";
        expect(
            defaultProviderCandidates("summary", member, organization),
        ).toEqual([
            {
                source: "member-role",
                providerId: "disabled-member-provider",
            },
        ]);
    });

    it("returns no credential before the transcription managed fallback", () => {
        expect(
            defaultProviderCandidates(
                "transcription" satisfies ResolutionStep,
                empty(),
                empty(),
            ),
        ).toEqual([]);
    });
});

describe("chat credential fallback", () => {
    const credentials = [
        {
            id: "own-chat",
            provider: "OpenAI",
            disabledAt: null,
            createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
    ];

    it("uses the first enabled own chat credential without an Organization default", () => {
        expect(
            defaultProviderCandidates("summary", empty(), empty(), credentials),
        ).toEqual([{ source: "member-fallback", providerId: "own-chat" }]);
    });

    it("keeps an Organization default ahead of the own chat fallback", () => {
        const organization = empty();
        organization.summary = "organization-chat";
        expect(
            defaultProviderCandidates(
                "summary",
                empty(),
                organization,
                credentials,
            ),
        ).toEqual([
            {
                source: "organization-role",
                providerId: "organization-chat",
            },
        ]);
    });

    it("skips a transcription-only first credential", () => {
        expect(
            defaultProviderCandidates("summary", empty(), null, [
                {
                    id: "audio-first",
                    provider: "ElevenLabs",
                    disabledAt: null,
                    createdAt: new Date("2026-01-01T00:00:00.000Z"),
                },
                ...credentials,
            ]),
        ).toEqual([{ source: "member-fallback", providerId: "own-chat" }]);
    });

    it("skips a disabled credential", () => {
        expect(
            defaultProviderCandidates("summary", empty(), null, [
                {
                    id: "disabled-chat",
                    provider: "OpenAI",
                    disabledAt: new Date("2026-01-01T00:00:00.000Z"),
                    createdAt: new Date("2026-01-01T00:00:00.000Z"),
                },
                ...credentials,
            ]),
        ).toEqual([{ source: "member-fallback", providerId: "own-chat" }]);
    });

    it("skips a managed credential", () => {
        expect(
            defaultProviderCandidates("summary", empty(), null, [
                {
                    id: "riffado-included",
                    provider: "Mynah",
                    managed: true,
                    disabledAt: null,
                    createdAt: new Date(0),
                },
                ...credentials,
            ]),
        ).toEqual([{ source: "member-fallback", providerId: "own-chat" }]);
    });
});

describe("Organization credential fallback", () => {
    const credential = (id: string, provider: string, day = 1) => ({
        id,
        provider,
        disabledAt: null as Date | null,
        createdAt: new Date(`2026-01-0${day}T00:00:00.000Z`),
    });
    const org = [
        credential("codex", "Codex"),
        credential("audio", "ElevenLabs", 2),
    ];

    it("puts the own implicit chat selection before the Organization implicit selection", () => {
        expect(
            defaultProviderCandidates(
                "summary",
                empty(),
                empty(),
                [credential("own", "OpenAI")],
                org,
            ),
        ).toEqual([
            { source: "member-fallback", providerId: "own" },
            { source: "organization-fallback", providerId: "codex" },
        ]);
    });

    it.each([
        "Codex",
        "Claude Code",
    ])("excludes %s bridge presets from transcription", (bridge) => {
        expect(
            defaultProviderCandidates(
                "transcription",
                empty(),
                empty(),
                [],
                [credential("bridge", bridge), ...org],
            ),
        ).toEqual([{ source: "organization-fallback", providerId: "audio" }]);
    });

    it.each([
        "summary",
        "learn",
        "topics",
        "title",
    ] as const)("excludes transcription-only credentials for %s", (step) => {
        expect(
            defaultProviderCandidates(
                step,
                empty(),
                empty(),
                [],
                [
                    credential("first-audio", "ElevenLabs"),
                    credential("chat", "Codex", 2),
                ],
            ),
        ).toEqual([{ source: "organization-fallback", providerId: "chat" }]);
    });

    it("skips disabled credentials and orders by creation time then id without changing the input", () => {
        const credentials = [
            credential("later", "Codex", 3),
            credential("b", "Codex", 2),
            credential("a", "Codex", 2),
            { ...credential("disabled", "OpenAI"), disabledAt: new Date() },
        ];
        expect(
            defaultProviderCandidates(
                "summary",
                empty(),
                empty(),
                [],
                credentials,
            ),
        ).toEqual([{ source: "organization-fallback", providerId: "a" }]);
        expect(credentials.map((row) => row.id)).toEqual([
            "later",
            "b",
            "a",
            "disabled",
        ]);
    });

    it("requires an authorized Organization scope even when credentials are supplied", () => {
        expect(
            defaultProviderCandidates("summary", empty(), null, [], org),
        ).toEqual([]);
    });

    it.each([
        "member",
        "organization",
    ] as const)("keeps an explicit %s pointer terminal ahead of all implicit choices", (owner) => {
        const member = empty();
        const organization = empty();
        (owner === "member" ? member : organization).summary = "missing";
        expect(
            defaultProviderCandidates(
                "summary",
                member,
                organization,
                [credential("own", "OpenAI")],
                org,
            ),
        ).toEqual([
            {
                source:
                    owner === "member" ? "member-role" : "organization-role",
                providerId: "missing",
            },
        ]);
    });
});
