import { describe, expect, it } from "vitest";

import { usesDefaultPostgresPassword } from "@/lib/postgres-password";

describe("usesDefaultPostgresPassword", () => {
    it.each([
        "postgresql://postgres:postgres@db:5432/riffado",
        "postgres://app:postgres@db:5432/riffado?sslmode=require",
        "postgresql://app:%70ostgres@db:5432/riffado",
        "postgresql://app:postgres@db:5432,replica:5432/riffado",
        "  postgresql://app:postgres@db:5432,replica:5432/riffado  ",
    ])("detects the default password in %s", (url) => {
        expect(usesDefaultPostgresPassword(url)).toBe(true);
    });

    it.each([
        "postgresql://postgres:postgres-extra@db:5432/riffado",
        "postgresql://postgres@db:5432/riffado",
        "postgresql://app:%ZZ@db:5432/riffado",
        "postgresql://%ZZ:postgres@db:5432/riffado",
        "postgresql://app:postgres@%ZZ:5432/riffado",
        "https://app:postgres@example.com/",
        "not-a-url",
        "",
        undefined,
    ])("ignores missing, different or malformed passwords in %s", (url) => {
        expect(usesDefaultPostgresPassword(url)).toBe(false);
    });
});
