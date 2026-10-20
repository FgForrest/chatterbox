import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userSettings, users } from "@/db/schema";
import { locales } from "@/lib/i18n/config";
import { resolveLearnReviewLocale } from "@/lib/learn/review-language";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("Learn reviewer locale (PostgreSQL)", () => {
    let database: TestPostgresDatabase;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "learn_review_language",
        );
        await database.db.insert(users).values([
            { id: "owner", email: "owner@example.test", uiLocale: "cs-CZ" },
            { id: "org", email: "org@example.test", uiLocale: "en" },
            { id: "curator", email: "curator@example.test", uiLocale: "cs-CZ" },
            { id: "unset", email: "unset@example.test" },
            {
                id: "unsupported",
                email: "unsupported@example.test",
                uiLocale: "de",
            },
            { id: "auto-cs", email: "auto-cs@example.test" },
        ]);
        await database.db.insert(userSettings).values({
            userId: "auto-cs",
            defaultTranscriptionLanguage: "cs",
        });
    }, 120_000);

    afterAll(async () => {
        await database?.dispose();
    }, 30_000);

    it("resolves the personal item owner's interface locale", async () => {
        expect(
            await resolveLearnReviewLocale(database.db, {
                userId: "owner",
                scopeUserId: "org",
                view: "private",
            }),
        ).toBe("cs-CZ");
    });

    it("uses the Organization's language account, independent of the owner and curator", async () => {
        const run = {
            userId: "owner",
            scopeUserId: "org",
            view: "org" as const,
            actorUserId: "curator",
        };
        expect(await resolveLearnReviewLocale(database.db, run)).toBe("en");
        expect(
            await resolveLearnReviewLocale(database.db, {
                ...run,
                userId: "org",
                scopeUserId: "owner",
            }),
        ).toBe("cs-CZ");
    });

    it("falls back to the actor, then the owner, when the Organization account has no locale", async () => {
        const run = {
            userId: "owner",
            scopeUserId: "unset",
            view: "org" as const,
            actorUserId: "curator",
        };
        expect(await resolveLearnReviewLocale(database.db, run)).toBe("cs-CZ");
        expect(
            await resolveLearnReviewLocale(database.db, {
                ...run,
                actorUserId: null,
            }),
        ).toBe("cs-CZ");
        expect(
            await resolveLearnReviewLocale(database.db, {
                ...run,
                userId: "unsupported",
                actorUserId: "missing",
            }),
        ).toBe("en");
    });

    it.each([
        "unset",
        "missing",
        "unsupported",
    ])("defaults to English for %s locale", async (userId) => {
        for (const view of ["private", "org"] as const) {
            expect(
                await resolveLearnReviewLocale(database.db, {
                    userId,
                    scopeUserId: userId,
                    view,
                }),
            ).toBe("en");
        }
    });

    it("follows the default transcription language when the interface locale is Auto", async () => {
        expect(
            await resolveLearnReviewLocale(database.db, {
                userId: "auto-cs",
                scopeUserId: "auto-cs",
                view: "private",
            }),
        ).toBe("cs-CZ");
        expect(
            await resolveLearnReviewLocale(database.db, {
                userId: "auto-cs",
                scopeUserId: "org",
                view: "org",
            }),
        ).toBe("en");
    });

    it("falls back to the content language before English", async () => {
        const run = {
            userId: "unset",
            scopeUserId: "unset",
            view: "private" as const,
        };
        expect(await resolveLearnReviewLocale(database.db, run, "cs")).toBe(
            "cs-CZ",
        );
        expect(await resolveLearnReviewLocale(database.db, run, "ces")).toBe(
            "cs-CZ",
        );
        expect(await resolveLearnReviewLocale(database.db, run, "cze")).toBe(
            "cs-CZ",
        );
        expect(await resolveLearnReviewLocale(database.db, run, "de")).toBe(
            "en",
        );
        expect(
            await resolveLearnReviewLocale(
                database.db,
                { userId: "owner", scopeUserId: "owner", view: "private" },
                "en",
            ),
        ).toBe("cs-CZ");
    });

    it.each(
        locales,
    )("resolves supported locale %s from the selected account", async (locale) => {
        const userId = locale === "en" ? "org" : "owner";
        expect(
            await resolveLearnReviewLocale(database.db, {
                userId,
                scopeUserId: userId,
                view: "private",
            }),
        ).toBe(locale);
    });
});
