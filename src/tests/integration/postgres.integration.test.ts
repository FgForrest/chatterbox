import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createMigratedTestDatabase, getTestDatabaseUrl } from "./postgres";

const adminUrl = getTestDatabaseUrl();

describe.skipIf(!adminUrl)("migrated test database template", () => {
    it("clones concurrently into independent writable databases without template connections", async () => {
        const templateName = process.env.VITEST_DATABASE_TEMPLATE;
        if (!templateName) throw new Error("test database template is missing");
        const admin = postgres(adminUrl ?? "", { max: 1 });
        const clones = await Promise.allSettled(
            Array.from({ length: 12 }, (_, index) =>
                createMigratedTestDatabase(adminUrl ?? "", `clone_${index}`),
            ),
        );
        try {
            const databases = clones.map((clone) => {
                if (clone.status === "rejected") throw clone.reason;
                return clone.value;
            });
            expect(
                new Set(databases.map((database) => database.name)).size,
            ).toBe(12);
            await Promise.all(
                databases.map(async (database) => {
                    const [migrations] = await database.sql`
                        select count(*)::int as count from drizzle.__drizzle_migrations
                    `;
                    expect(migrations.count).toBeGreaterThan(0);
                    await database.sql`
                        insert into users (id, email) values ('clone-user', 'clone@example.test')
                    `;
                    const [row] = await database.sql`
                        select count(*)::int as count from users where id = 'clone-user'
                    `;
                    expect(row.count).toBe(1);
                }),
            );
            const [template] = await admin`
                select datallowconn from pg_database
                where datname = ${templateName}
            `;
            expect(template.datallowconn).toBe(false);
            const connections = await admin`
                select pid from pg_stat_activity
                where datname = ${templateName}
            `;
            expect(connections).toHaveLength(0);
        } finally {
            try {
                await Promise.all(
                    clones.map((clone) =>
                        clone.status === "fulfilled"
                            ? clone.value.dispose()
                            : undefined,
                    ),
                );
            } finally {
                await admin.end();
            }
        }
    }, 120_000);
});
