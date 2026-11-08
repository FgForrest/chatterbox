import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "@/db/schema";

export type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface TestPostgresDatabase {
    name: string;
    url: string;
    db: TestDatabase;
    sql: ReturnType<typeof postgres>;
    dispose: () => Promise<void>;
}

const LOCAL_DATABASE_HOSTS = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
]);
const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(
    new URL("../../db/migrations", import.meta.url),
);

export function getTestDatabaseUrl(): string | null {
    const value = process.env.TEST_DATABASE_URL?.trim();
    return value ? value : null;
}

function assertSafeAdminUrl(rawUrl: string): void {
    const url = new URL(rawUrl);
    if (
        process.env.ALLOW_REMOTE_TEST_DATABASE_URL !== "true" &&
        !LOCAL_DATABASE_HOSTS.has(url.hostname)
    ) {
        throw new Error(
            "TEST_DATABASE_URL must point at localhost unless ALLOW_REMOTE_TEST_DATABASE_URL=true is set",
        );
    }
}

function databaseUrlFor(adminUrl: string, databaseName: string): string {
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    return url.toString();
}

// The migration chain runs in one transaction, which holds a lock on every
// relation it creates until it commits. Postgres keeps those in one shared
// table (`max_locks_per_transaction` x `max_connections`, 6,400 by default),
// and a machine with many cores runs one test file per core, each migrating
// its own database at once: past a few dozen tables that runs out ("out of
// shared memory"). So only this many migrate at a time, across processes,
// by session advisory locks on the admin database.
const MIGRATION_SLOTS = 6;
const MIGRATION_LOCK_BASE = 72_457_000;

async function withMigrationSlot<T>(
    adminUrl: string,
    run: () => Promise<T>,
): Promise<T> {
    const gate = postgres(adminUrl, { max: 1 });
    try {
        for (;;) {
            for (let slot = 0; slot < MIGRATION_SLOTS; slot++) {
                const key = MIGRATION_LOCK_BASE + slot;
                const [row] =
                    await gate`select pg_try_advisory_lock(${key}) as taken`;
                if (row?.taken) {
                    try {
                        return await run();
                    } finally {
                        await gate`select pg_advisory_unlock(${key})`;
                    }
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    } finally {
        await gate.end();
    }
}

function makeDatabaseName(label: string): string {
    const safeLabel = label.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const suffix = randomBytes(6).toString("hex");
    return `riffado_test_${safeLabel}_${process.pid}_${suffix}`;
}

/** Applies the migrations in `migrationsFolder` not yet applied to `db`. */
export async function migrateTestDatabase(
    adminUrl: string,
    db: TestDatabase,
    migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
): Promise<void> {
    await withMigrationSlot(adminUrl, () => migrate(db, { migrationsFolder }));
}

/**
 * Creates an isolated scratch database, cloning the run's migrated template for
 * the default migrations folder or applying custom migrations directly.
 */
export async function createMigratedTestDatabase(
    adminUrl: string,
    label: string,
    migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
): Promise<TestPostgresDatabase> {
    assertSafeAdminUrl(adminUrl);
    if (resolve(migrationsFolder) !== DEFAULT_MIGRATIONS_FOLDER) {
        return createTestDatabase(adminUrl, label, migrationsFolder);
    }
    const templateName = process.env.VITEST_DATABASE_TEMPLATE;
    if (!templateName) {
        throw new Error(
            "The migrated test database template is missing; run Vitest with vitest.config.ts",
        );
    }
    return createTestDatabase(adminUrl, label, migrationsFolder, templateName);
}

/** Creates a migrated, connection-free template, disposed after the test run. */
export async function createTestDatabaseTemplate(
    adminUrl: string,
): Promise<Pick<TestPostgresDatabase, "name" | "dispose">> {
    const database = await createTestDatabase(
        adminUrl,
        "template",
        DEFAULT_MIGRATIONS_FOLDER,
    );
    try {
        await database.sql.end({ timeout: 5 });
        const admin = postgres(adminUrl, { max: 1 });
        try {
            await admin`alter database ${admin(database.name)} with allow_connections false`;
        } finally {
            await admin.end();
        }
    } catch (error) {
        await database.dispose();
        throw error;
    }
    return { name: database.name, dispose: database.dispose };
}

async function createTestDatabase(
    adminUrl: string,
    label: string,
    migrationsFolder: string,
    templateName?: string,
): Promise<TestPostgresDatabase> {
    assertSafeAdminUrl(adminUrl);

    const name = makeDatabaseName(label);
    const admin = postgres(adminUrl, { max: 1 });
    try {
        if (templateName) {
            await admin`create database ${admin(name)} template ${admin(templateName)}`;
        } else {
            await admin`create database ${admin(name)}`;
        }
    } finally {
        await admin.end();
    }

    const url = databaseUrlFor(adminUrl, name);
    const client = postgres(url, { max: 20 });
    const db = drizzle(client, { schema });

    const dispose = async () => {
        try {
            await client.end({ timeout: 5 });
        } finally {
            const dropAdmin = postgres(adminUrl, { max: 1 });
            try {
                await dropAdmin`drop database if exists ${dropAdmin(name)} with (force)`;
            } finally {
                await dropAdmin.end();
            }
        }
    };

    try {
        if (!templateName) {
            await migrateTestDatabase(adminUrl, db, migrationsFolder);
        }
    } catch (error) {
        await dispose();
        throw error;
    }

    return {
        name,
        url,
        db,
        sql: client,
        dispose,
    };
}
