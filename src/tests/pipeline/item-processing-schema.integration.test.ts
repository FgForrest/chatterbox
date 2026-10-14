import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chatterItems, itemProcessing, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const USER_ID = "item-processing-user";
const ITEM_ID = "item-processing-item";

describeWithDatabase("item_processing schema", () => {
    let database: TestPostgresDatabase | null = null;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "item_processing_schema",
        );
        await database.db.insert(users).values({
            id: USER_ID,
            email: "item-processing@example.test",
        });
    }, 120_000);

    beforeEach(async () => {
        if (!database) throw new Error("test database was not initialized");

        await database.db
            .delete(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, ITEM_ID),
                    eq(chatterItems.userId, USER_ID),
                ),
            );
        await database.db.insert(chatterItems).values({
            id: ITEM_ID,
            userId: USER_ID,
            kind: "audio",
            title: "Test recording",
            occurredAt: new Date("2026-10-14T00:00:00.000Z"),
        });
    });

    afterAll(async () => {
        await database?.dispose();
    }, 30_000);

    it("applies the migration chain and accepts the org view", async () => {
        if (!database) throw new Error("test database was not initialized");

        const [{ table_name: tableName }] = await database.sql<
            { table_name: string | null }[]
        >`select to_regclass('public.item_processing')::text as table_name`;
        expect(tableName).toBe("item_processing");

        await expect(
            database.db.insert(itemProcessing).values({
                itemId: ITEM_ID,
                userId: USER_ID,
                view: "org",
            }),
        ).resolves.toBeDefined();
    });

    it("rejects a view outside private and org", async () => {
        if (!database) throw new Error("test database was not initialized");

        await expect(
            database.sql`
                insert into item_processing (item_id, user_id, view)
                values (${ITEM_ID}, ${USER_ID}, 'other')
            `,
        ).rejects.toThrow(/item_processing_view_check/);
    });

    it("rejects a duplicate item and view", async () => {
        if (!database) throw new Error("test database was not initialized");

        const row = {
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
        } as const;
        await database.db.insert(itemProcessing).values(row);

        await expect(
            database.db.insert(itemProcessing).values(row),
        ).rejects.toThrow();
    });

    it("deletes processing rows with their chatter item", async () => {
        if (!database) throw new Error("test database was not initialized");

        await database.db.insert(itemProcessing).values([
            { itemId: ITEM_ID, userId: USER_ID, view: "private" },
            { itemId: ITEM_ID, userId: USER_ID, view: "org" },
        ]);

        await database.db
            .delete(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, ITEM_ID),
                    eq(chatterItems.userId, USER_ID),
                ),
            );

        const rows = await database.db
            .select()
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM_ID),
                    eq(itemProcessing.userId, USER_ID),
                ),
            );
        expect(rows).toEqual([]);
    });
});
