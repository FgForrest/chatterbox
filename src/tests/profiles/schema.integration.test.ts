import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    chatterItems,
    folderDefaultProfiles,
    itemProcessing,
    processingProfileRevisions,
    processingProfiles,
    recordingFolders,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const USER_ID = "profiles-schema-user";
const ITEM_ID = "profiles-schema-item";
const FOLDER_ID = "profiles-schema-folder";

describeWithDatabase("processing profiles schema", () => {
    let database: TestPostgresDatabase | null = null;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "processing_profiles_schema",
        );
        await database.db.insert(users).values({
            id: USER_ID,
            email: "profiles-schema@example.test",
        });
    }, 120_000);

    beforeEach(async () => {
        if (!database) throw new Error("test database was not initialized");

        await database.db
            .delete(recordingFolders)
            .where(eq(recordingFolders.userId, USER_ID));
        await database.db
            .delete(chatterItems)
            .where(eq(chatterItems.userId, USER_ID));
        await database.db
            .delete(processingProfiles)
            .where(eq(processingProfiles.ownerUserId, USER_ID));

        await database.db.insert(chatterItems).values({
            id: ITEM_ID,
            userId: USER_ID,
            kind: "audio",
            title: "Encrypted title",
            occurredAt: new Date("2026-10-14T00:00:00.000Z"),
        });
        await database.db.insert(recordingFolders).values({
            id: FOLDER_ID,
            userId: USER_ID,
            name: "Encrypted folder",
            nameHash: "profiles-schema-folder-hash",
        });
    });

    afterAll(async () => {
        await database?.dispose();
    }, 30_000);

    it("applies the migration chain with the profile tables and run columns", async () => {
        if (!database) throw new Error("test database was not initialized");

        const [tables] = await database.sql<
            {
                profiles: string | null;
                revisions: string | null;
                folder_defaults: string | null;
            }[]
        >`
            select
                to_regclass('public.processing_profiles')::text as profiles,
                to_regclass('public.processing_profile_revisions')::text as revisions,
                to_regclass('public.folder_default_profiles')::text as folder_defaults
        `;
        expect(tables).toEqual({
            profiles: "processing_profiles",
            revisions: "processing_profile_revisions",
            folder_defaults: "folder_default_profiles",
        });

        const columns = await database.sql<
            { table_name: string; column_name: string }[]
        >`
            select table_name, column_name
            from information_schema.columns
            where (table_name = 'api_credentials' and column_name = 'disabled_at')
               or (table_name = 'ai_enhancements' and column_name in (
                    'profile_revision_id', 'builtin_prompts_version', 'inputs',
                    'output_language', 'output_format_locale', 'payer_user_id'
               ))
               or (table_name = 'transcriptions' and column_name in (
                    'profile_revision_id', 'builtin_prompts_version', 'inputs',
                    'payer_user_id'
               ))
               or (table_name = 'learn_runs' and column_name in (
                    'profile_revision_id', 'builtin_prompts_version', 'inputs',
                    'payer_user_id'
               ))
               or (table_name = 'ai_usage_events' and column_name = 'actor_user_id')
        `;
        expect(columns).toHaveLength(16);

        const indexes = await database.sql<{ indexname: string }[]>`
            select indexname
            from pg_indexes
            where schemaname = 'public'
              and indexname in (
                  'transcriptions_payer_user_id_idx',
                  'ai_enhancements_payer_user_id_idx',
                  'learn_runs_payer_user_id_idx',
                  'ai_usage_events_actor_user_id_idx',
                  'item_processing_profile_id_idx',
                  'processing_profiles_created_by_idx',
                  'processing_profiles_updated_by_idx',
                  'processing_profile_revisions_created_by_idx'
              )
            order by indexname
        `;
        expect(indexes.map(({ indexname }) => indexname)).toEqual([
            "ai_enhancements_payer_user_id_idx",
            "ai_usage_events_actor_user_id_idx",
            "item_processing_profile_id_idx",
            "learn_runs_payer_user_id_idx",
            "processing_profile_revisions_created_by_idx",
            "processing_profiles_created_by_idx",
            "processing_profiles_updated_by_idx",
            "transcriptions_payer_user_id_idx",
        ]);

        const partialIndexes = await database.sql<
            { indexname: string; indexdef: string }[]
        >`
            select indexname, indexdef
            from pg_indexes
            where schemaname = 'public'
              and indexname in (
                  'ai_usage_events_actor_user_id_idx',
                  'item_processing_profile_id_idx',
                  'processing_profiles_created_by_idx',
                  'processing_profiles_updated_by_idx',
                  'processing_profile_revisions_created_by_idx'
              )
        `;
        expect(partialIndexes).toHaveLength(5);
        expect(
            partialIndexes.every(({ indexdef }) =>
                /WHERE \(.+ IS NOT NULL\)/.test(indexdef),
            ),
        ).toBe(true);
    });

    it("rejects unsupported profile scopes and channels", async () => {
        if (!database) throw new Error("test database was not initialized");

        await expect(
            database.sql`
                insert into processing_profiles (
                    id, owner_user_id, scope, channel, name
                ) values (
                    'profile-bad-scope', ${USER_ID}, 'team', 'audio', 'ciphertext'
                )
            `,
        ).rejects.toThrow(/processing_profiles_scope_check/);

        await expect(
            database.sql`
                insert into processing_profiles (
                    id, owner_user_id, scope, channel, name
                ) values (
                    'profile-bad-channel', ${USER_ID}, 'personal', 'video', 'ciphertext'
                )
            `,
        ).rejects.toThrow(/processing_profiles_channel_check/);

        await database.db.insert(processingProfiles).values({
            id: "profile-folder-channel",
            ownerUserId: USER_ID,
            scope: "personal",
            channel: "audio",
            name: "ciphertext",
        });
        await expect(
            database.sql`
                insert into folder_default_profiles (folder_id, channel, profile_id)
                values (${FOLDER_ID}, 'video', 'profile-folder-channel')
            `,
        ).rejects.toThrow(/folder_default_profiles_channel_check/);
    });

    it("allows only one live default per owner and channel", async () => {
        if (!database) throw new Error("test database was not initialized");

        await database.db.insert(processingProfiles).values({
            id: "profile-live-default",
            ownerUserId: USER_ID,
            scope: "personal",
            channel: "audio",
            name: "ciphertext",
            isDefault: true,
        });

        await expect(
            database.db.insert(processingProfiles).values({
                id: "profile-second-live-default",
                ownerUserId: USER_ID,
                scope: "personal",
                channel: "audio",
                name: "ciphertext",
                isDefault: true,
            }),
        ).rejects.toThrow();
    });

    it("allows an archived default beside a live default", async () => {
        if (!database) throw new Error("test database was not initialized");

        await expect(
            database.db.insert(processingProfiles).values([
                {
                    id: "profile-archived-default",
                    ownerUserId: USER_ID,
                    scope: "personal",
                    channel: "mail",
                    name: "ciphertext",
                    isDefault: true,
                    archivedAt: new Date("2026-10-13T00:00:00.000Z"),
                },
                {
                    id: "profile-current-default",
                    ownerUserId: USER_ID,
                    scope: "personal",
                    channel: "mail",
                    name: "ciphertext",
                    isDefault: true,
                },
            ]),
        ).resolves.toBeDefined();
    });

    it("keeps item and folder assignments while cascading profile revisions", async () => {
        if (!database) throw new Error("test database was not initialized");

        const profileId = "profile-delete";
        const revisionId = "profile-delete-revision";
        await database.db.insert(processingProfiles).values({
            id: profileId,
            ownerUserId: USER_ID,
            scope: "personal",
            channel: "audio",
            name: "ciphertext",
            currentRevisionId: revisionId,
        });
        await database.db.insert(processingProfileRevisions).values({
            id: revisionId,
            profileId,
            settings: "encrypted-json",
        });
        await database.db.insert(folderDefaultProfiles).values({
            folderId: FOLDER_ID,
            channel: "audio",
            profileId,
        });
        await database.db.insert(itemProcessing).values({
            itemId: ITEM_ID,
            userId: USER_ID,
            view: "private",
            profileId,
            profileRevisionId: revisionId,
        });

        await database.db
            .delete(processingProfiles)
            .where(eq(processingProfiles.id, profileId));

        const [folderDefault] = await database.db
            .select()
            .from(folderDefaultProfiles)
            .where(
                and(
                    eq(folderDefaultProfiles.folderId, FOLDER_ID),
                    eq(folderDefaultProfiles.channel, "audio"),
                ),
            );
        expect(folderDefault?.profileId).toBeNull();

        const [processing] = await database.db
            .select()
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM_ID),
                    eq(itemProcessing.view, "private"),
                ),
            );
        expect(processing).toMatchObject({
            profileId: null,
            profileRevisionId: revisionId,
        });

        const revisions = await database.db
            .select()
            .from(processingProfileRevisions)
            .where(eq(processingProfileRevisions.profileId, profileId));
        expect(revisions).toEqual([]);
    });

    it("deletes folder defaults with their folder", async () => {
        if (!database) throw new Error("test database was not initialized");

        await database.db.insert(processingProfiles).values({
            id: "profile-folder-delete",
            ownerUserId: USER_ID,
            scope: "personal",
            channel: "mail",
            name: "ciphertext",
        });
        await database.db.insert(folderDefaultProfiles).values({
            folderId: FOLDER_ID,
            channel: "mail",
            profileId: "profile-folder-delete",
        });

        await database.db
            .delete(recordingFolders)
            .where(eq(recordingFolders.id, FOLDER_ID));

        const defaults = await database.db
            .select()
            .from(folderDefaultProfiles)
            .where(eq(folderDefaultProfiles.folderId, FOLDER_ID));
        expect(defaults).toEqual([]);
    });
});
