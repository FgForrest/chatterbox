import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import {
    receivedItemCondition,
    receivedThroughFolderCondition,
} from "@/db/queries/item-shares";
import { chatterItems } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { ref, proxy } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        ref,
        proxy: new Proxy(
            {},
            {
                get(_target, key) {
                    if (!ref.current) throw new Error("Database not ready");
                    const value = ref.current[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});
vi.mock("@/db", () => ({ db: proxy, sqlClient: null }));

vi.mock("@/lib/env", () => ({
    env: { AUTHZ_MODE: "local", IS_HOSTED: false },
}));
vi.mock("@/lib/org/config", () => ({ isOrgScopeVisible: () => true }));
interface PlanNode {
    "Node Type": string;
    "Relation Name"?: string;
    "Index Name"?: string;
    "Actual Rows": number;
    "Actual Loops": number;
    Plans?: PlanNode[];
}
function flatten(node: PlanNode): PlanNode[] {
    return [node, ...(node.Plans ?? []).flatMap(flatten)];
}
const databaseUrl = getTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
suite("received item query plans (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            databaseUrl ?? "",
            "received_plans",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
        await database.sql`insert into users (id,email,name) values ('stranger','stranger@example.com','Stranger'),('other','other@example.com','Other')`;
        await database.sql`insert into users (id, email, name) select 'u-'||n, 'u-'||n||'@example.com', 'User '||n from generate_series(1,1000) n`;
        await database.sql`insert into recording_folders (id,user_id,name,name_hash,kind,parent_id) select 'f-'||n, 'u-'||n, 'Folder', 'hash-'||n, 'custom',null from generate_series(1,1000) n`;
        await database.sql`insert into chatter_items (id,user_id,title,kind,occurred_at) select 'i-'||n, 'u-'||((n-1)%1000+1), 'Item', 'audio',now() from generate_series(1,100000) n`;
        await database.sql`insert into recording_folder_assignments (recording_id,user_id,folder_id) select 'i-'||n, 'u-'||((n-1)%1000+1), 'f-'||((n-1)%1000+1) from generate_series(1,100000) n`;
        await database.sql`insert into folder_shares (id,user_id,receiver_user_id,folder_id,state) values ('share-1','u-1','other','f-1','accepted')`;
        await database.sql`analyze`;
    }, 120000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    }, 60000);
    it.each([
        "stranger",
        "other",
    ])("only visits eligible folder assignments for %s", async (userId) => {
        for (const [label, predicate] of [
            ["receivedItemCondition", receivedItemCondition(userId)],
            [
                "receivedThroughFolderCondition",
                receivedThroughFolderCondition(userId),
            ],
        ] as const) {
            const query = db
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(predicate)
                .toSQL();
            const result = await database.sql.unsafe(
                `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
                query.params as string[],
            );
            const [plan] = result[0]["QUERY PLAN"] as {
                Plan: PlanNode;
                "Execution Time": number;
            }[];
            console.info(`${label} (${userId}): ${JSON.stringify(plan)}`);
            const nodes = flatten(plan.Plan);
            const assignmentScans = nodes.filter(
                (node) =>
                    node["Relation Name"] === "recording_folder_assignments",
            );
            expect(assignmentScans.length).toBeGreaterThan(0);
            expect(
                assignmentScans.every(
                    (node) => node["Node Type"] !== "Seq Scan",
                ),
            ).toBe(true);
            expect(
                nodes.some(
                    (node) =>
                        node["Index Name"] ===
                        "recording_folder_assignments_folder_id_idx",
                ),
            ).toBe(true);
            expect(
                assignmentScans.reduce(
                    (total, node) =>
                        total + node["Actual Rows"] * node["Actual Loops"],
                    0,
                ),
            ).toBe(userId === "stranger" ? 0 : 100);
            expect(plan.Plan["Actual Rows"]).toBe(
                userId === "stranger" ? 0 : 100,
            );
        }
    });
});
