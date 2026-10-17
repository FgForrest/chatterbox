import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import { processingProfileRevisions, processingProfiles } from "@/db/schema";
import type { ActorContext } from "@/lib/authz/model";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { getOrgUserId } from "@/lib/org/config";
import { mayEditProfile, mayUseProfile } from "@/lib/profiles/access";
import {
    type ProfileChannel,
    type ProfileScope,
    type ProfileSettings,
    parseProfileSettings,
} from "@/lib/profiles/settings";

type StoredProfile = typeof processingProfiles.$inferSelect;

export type ProfileRecord = Omit<StoredProfile, "name" | "description"> & {
    name: string;
    description: string | null;
    settings: ProfileSettings;
};

interface SelectedProfile {
    profile: StoredProfile;
    revisionSettings: string | null;
}

export class ProfileVersionConflictError extends Error {
    constructor(
        readonly expectedVersion: number,
        readonly actualVersion: number | null,
    ) {
        super(
            actualVersion === null
                ? `Profile version ${expectedVersion} is no longer current`
                : `Expected profile version ${expectedVersion}, found ${actualVersion}`,
        );
        this.name = "ProfileVersionConflictError";
    }
}

export class ProfilePermissionError extends Error {
    constructor() {
        super("Profile access denied");
        this.name = "ProfilePermissionError";
    }
}

export class DefaultProfileArchiveError extends Error {
    constructor() {
        super("Choose another default profile before archiving this one");
        this.name = "DefaultProfileArchiveError";
    }
}

function settingsFrom(
    channel: ProfileChannel,
    encrypted: string | null,
): ProfileSettings {
    if (!encrypted) throw new Error("Profile has no current revision");
    return parseProfileSettings(channel, JSON.parse(decryptText(encrypted)));
}

function present(row: SelectedProfile): ProfileRecord {
    return {
        ...row.profile,
        name: decryptText(row.profile.name),
        description: decryptText(row.profile.description) ?? null,
        settings: settingsFrom(row.profile.channel, row.revisionSettings),
    };
}

async function assertCreateAccess(
    actor: ActorContext,
    ownerUserId: string,
    scope: ProfileScope,
): Promise<void> {
    if (scope === "organization") {
        const orgUserId = await getOrgUserId();
        if (orgUserId !== ownerUserId) throw new ProfilePermissionError();
    }
    if (!(await mayEditProfile(actor, { ownerUserId, scope }))) {
        throw new ProfilePermissionError();
    }
}

async function assertEditAccess(
    actor: ActorContext,
    profile: Pick<ProfileRecord, "ownerUserId" | "scope">,
): Promise<void> {
    if (!(await mayEditProfile(actor, profile))) {
        throw new ProfilePermissionError();
    }
}

export interface ListProfilesInput {
    ownerUserId: string;
    actorUserId: string;
    search?: string;
    channel?: ProfileChannel;
    scope?: ProfileScope;
    offset?: number;
    limit?: number;
    includeArchived?: boolean;
}

export interface ProfilePage {
    items: ProfileRecord[];
    total: number;
    offset: number;
    limit: number;
}

/**
 * List one owner's profiles. Names must be decrypted before search, so the
 * expected small per-owner collection is filtered and paginated in memory.
 */
export async function listProfiles(
    input: ListProfilesInput,
): Promise<ProfilePage> {
    const rows = await db
        .select({
            profile: processingProfiles,
            revisionSettings: processingProfileRevisions.settings,
        })
        .from(processingProfiles)
        .leftJoin(
            processingProfileRevisions,
            and(
                eq(
                    processingProfileRevisions.id,
                    processingProfiles.currentRevisionId,
                ),
                eq(processingProfileRevisions.profileId, processingProfiles.id),
            ),
        )
        .where(
            and(
                eq(processingProfiles.ownerUserId, input.ownerUserId),
                input.includeArchived
                    ? undefined
                    : isNull(processingProfiles.archivedAt),
            ),
        )
        .orderBy(asc(processingProfiles.createdAt), asc(processingProfiles.id));

    const search = input.search?.trim().toLocaleLowerCase();
    const permitted = await Promise.all(
        rows.map(async (row) => {
            const profile = present(row);
            return (await mayUseProfile(input.actorUserId, profile))
                ? profile
                : null;
        }),
    );
    const filtered = permitted.filter(
        (profile): profile is ProfileRecord =>
            profile !== null &&
            (!input.channel || profile.channel === input.channel) &&
            (!input.scope || profile.scope === input.scope) &&
            (!search || profile.name.toLocaleLowerCase().includes(search)),
    );
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(100, Math.max(1, input.limit ?? 25));
    return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
    };
}

export interface ListActorProfilesInput {
    actor: ActorContext;
    search?: string;
    channel?: ProfileChannel;
    scope?: ProfileScope;
    offset?: number;
    limit?: number;
    archivedOnly?: boolean;
}

/** List the actor's personal profiles and Organization profiles they may use. */
export async function listActorProfiles(
    input: ListActorProfilesInput,
): Promise<ProfilePage> {
    const orgUserId = await getOrgUserId();
    const actorUserId = input.actor.actorId;
    const permittedOwners = or(
        and(
            eq(processingProfiles.ownerUserId, actorUserId),
            eq(processingProfiles.scope, "personal"),
        ),
        orgUserId
            ? and(
                  eq(processingProfiles.ownerUserId, orgUserId),
                  eq(processingProfiles.scope, "organization"),
              )
            : undefined,
    );
    const rows = await db
        .select({
            profile: processingProfiles,
            revisionSettings: processingProfileRevisions.settings,
        })
        .from(processingProfiles)
        .leftJoin(
            processingProfileRevisions,
            and(
                eq(
                    processingProfileRevisions.id,
                    processingProfiles.currentRevisionId,
                ),
                eq(processingProfileRevisions.profileId, processingProfiles.id),
            ),
        )
        .where(
            and(
                permittedOwners,
                input.archivedOnly
                    ? isNotNull(processingProfiles.archivedAt)
                    : isNull(processingProfiles.archivedAt),
            ),
        )
        .orderBy(asc(processingProfiles.createdAt), asc(processingProfiles.id));
    const search = input.search?.trim().toLocaleLowerCase();
    const permitted = await Promise.all(
        rows.map(async (row) => {
            const profile = present(row);
            return (await mayUseProfile(actorUserId, profile)) ? profile : null;
        }),
    );
    const filtered = permitted.filter(
        (profile): profile is ProfileRecord =>
            profile !== null &&
            (!input.channel || profile.channel === input.channel) &&
            (!input.scope || profile.scope === input.scope) &&
            (!search ||
                profile.name.toLocaleLowerCase().includes(search) ||
                (profile.description?.toLocaleLowerCase().includes(search) ??
                    false)),
    );
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(100, Math.max(1, input.limit ?? 25));
    return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
    };
}

/** Read one profile only through its owner. */
export async function getProfile(
    ownerUserId: string,
    profileId: string,
    actorUserId: string,
    options: { includeArchived?: boolean } = {},
): Promise<ProfileRecord | null> {
    const [row] = await db
        .select({
            profile: processingProfiles,
            revisionSettings: processingProfileRevisions.settings,
        })
        .from(processingProfiles)
        .leftJoin(
            processingProfileRevisions,
            and(
                eq(
                    processingProfileRevisions.id,
                    processingProfiles.currentRevisionId,
                ),
                eq(processingProfileRevisions.profileId, processingProfiles.id),
            ),
        )
        .where(
            and(
                eq(processingProfiles.ownerUserId, ownerUserId),
                eq(processingProfiles.id, profileId),
                options.includeArchived
                    ? undefined
                    : isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!row) return null;
    const profile = present(row);
    return (await mayUseProfile(actorUserId, profile)) ? profile : null;
}

/** Read one owner's live default profile for a channel. */
export async function getDefaultProfile(
    ownerUserId: string,
    channel: ProfileChannel,
    actorUserId: string,
): Promise<ProfileRecord | null> {
    const [row] = await db
        .select({
            profile: processingProfiles,
            revisionSettings: processingProfileRevisions.settings,
        })
        .from(processingProfiles)
        .leftJoin(
            processingProfileRevisions,
            and(
                eq(
                    processingProfileRevisions.id,
                    processingProfiles.currentRevisionId,
                ),
                eq(processingProfileRevisions.profileId, processingProfiles.id),
            ),
        )
        .where(
            and(
                eq(processingProfiles.ownerUserId, ownerUserId),
                eq(processingProfiles.channel, channel),
                eq(processingProfiles.isDefault, true),
                isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!row) return null;
    const profile = present(row);
    return (await mayUseProfile(actorUserId, profile)) ? profile : null;
}

export interface CreateProfileInput {
    ownerUserId: string;
    actor: ActorContext;
    scope: ProfileScope;
    channel: ProfileChannel;
    name: string;
    description?: string | null;
    settings: ProfileSettings;
    isDefault?: boolean;
}

/** Create a profile and its first immutable revision atomically. */
export async function createProfile(
    input: CreateProfileInput,
): Promise<ProfileRecord> {
    await assertCreateAccess(input.actor, input.ownerUserId, input.scope);
    const settings = parseProfileSettings(input.channel, input.settings);
    const profileId = nanoid();
    const revisionId = nanoid();

    return db.transaction(async (tx) => {
        const [profile] = await tx
            .insert(processingProfiles)
            .values({
                id: profileId,
                ownerUserId: input.ownerUserId,
                scope: input.scope,
                channel: input.channel,
                name: encryptText(input.name.trim()),
                description: encryptText(input.description?.trim() || null),
                isDefault: input.isDefault ?? false,
                currentRevisionId: revisionId,
                createdBy: input.actor.actorId,
                updatedBy: input.actor.actorId,
            })
            .returning();
        if (!profile) throw new Error("Profile insert returned no row");
        await tx.insert(processingProfileRevisions).values({
            id: revisionId,
            profileId,
            settings: encryptText(JSON.stringify(settings)),
            createdBy: input.actor.actorId,
        });
        return present({
            profile,
            revisionSettings: encryptText(JSON.stringify(settings)),
        });
    });
}

export interface UpdateProfileInput {
    ownerUserId: string;
    profileId: string;
    actor: ActorContext;
    expectedVersion: number;
    name?: string;
    description?: string | null;
    settings?: ProfileSettings;
    isDefault?: boolean;
}

/** Save a new immutable revision using an owner-scoped optimistic update. */
export async function updateProfile(
    input: UpdateProfileInput,
): Promise<ProfileRecord | null> {
    return db.transaction(async (tx) => {
        const [current] = await tx
            .select({
                profile: processingProfiles,
                revisionSettings: processingProfileRevisions.settings,
            })
            .from(processingProfiles)
            .leftJoin(
                processingProfileRevisions,
                and(
                    eq(
                        processingProfileRevisions.id,
                        processingProfiles.currentRevisionId,
                    ),
                    eq(
                        processingProfileRevisions.profileId,
                        processingProfiles.id,
                    ),
                ),
            )
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    eq(processingProfiles.id, input.profileId),
                    isNull(processingProfiles.archivedAt),
                ),
            )
            .limit(1);
        if (!current) return null;
        await assertEditAccess(input.actor, current.profile);
        if (current.profile.version !== input.expectedVersion) {
            throw new ProfileVersionConflictError(
                input.expectedVersion,
                current.profile.version,
            );
        }

        const settings = input.settings
            ? parseProfileSettings(current.profile.channel, input.settings)
            : settingsFrom(current.profile.channel, current.revisionSettings);
        const revisionId = nanoid();
        const now = new Date();
        const [updated] = await tx
            .update(processingProfiles)
            .set({
                name:
                    input.name === undefined
                        ? current.profile.name
                        : encryptText(input.name.trim()),
                description:
                    input.description === undefined
                        ? current.profile.description
                        : encryptText(input.description?.trim() || null),
                isDefault: input.isDefault ?? current.profile.isDefault,
                currentRevisionId: revisionId,
                version: input.expectedVersion + 1,
                updatedBy: input.actor.actorId,
                updatedAt: now,
            })
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    eq(processingProfiles.id, input.profileId),
                    eq(processingProfiles.version, input.expectedVersion),
                    isNull(processingProfiles.archivedAt),
                ),
            )
            .returning();
        if (!updated) {
            const [latest] = await tx
                .select({ version: processingProfiles.version })
                .from(processingProfiles)
                .where(
                    and(
                        eq(processingProfiles.ownerUserId, input.ownerUserId),
                        eq(processingProfiles.id, input.profileId),
                    ),
                )
                .limit(1);
            throw new ProfileVersionConflictError(
                input.expectedVersion,
                latest?.version ?? null,
            );
        }
        const encryptedSettings = encryptText(JSON.stringify(settings));
        await tx.insert(processingProfileRevisions).values({
            id: revisionId,
            profileId: updated.id,
            settings: encryptedSettings,
            createdBy: input.actor.actorId,
        });
        return present({
            profile: updated,
            revisionSettings: encryptedSettings,
        });
    });
}

export interface DuplicateProfileInput {
    sourceOwnerUserId: string;
    profileId: string;
    actor: ActorContext;
    name?: string;
}

/** Copy an available profile into the acting user's personal scope. */
export async function duplicateProfile(
    input: DuplicateProfileInput,
): Promise<ProfileRecord> {
    if (input.actor.kind !== "user") throw new ProfilePermissionError();
    const source = await getProfile(
        input.sourceOwnerUserId,
        input.profileId,
        input.actor.actorId,
    );
    if (!source) {
        throw new ProfilePermissionError();
    }
    return createProfile({
        ownerUserId: input.actor.actorId,
        actor: input.actor,
        scope: "personal",
        channel: source.channel,
        name: input.name ?? `${source.name} copy`,
        description: source.description,
        settings: source.settings,
        isDefault: false,
    });
}

export interface ArchiveProfileInput {
    ownerUserId: string;
    profileId: string;
    actor: ActorContext;
}

export interface RestoreProfileInput {
    ownerUserId: string;
    profileId: string;
    actor: ActorContext;
}

export interface SetDefaultProfileInput {
    ownerUserId: string;
    profileId: string;
    actor: ActorContext;
}

/** Atomically replace an owner's default profile for one channel. */
export async function setDefaultProfile(
    input: SetDefaultProfileInput,
): Promise<boolean> {
    return db.transaction(async (tx) => {
        const profiles = await tx
            .select()
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    isNull(processingProfiles.archivedAt),
                ),
            )
            .orderBy(processingProfiles.id)
            .for("update");
        const target = profiles.find(
            (profile) => profile.id === input.profileId,
        );
        if (!target) return false;
        await assertEditAccess(input.actor, target);
        if (target.isDefault) return true;

        const now = new Date();
        await tx
            .update(processingProfiles)
            .set({
                isDefault: false,
                version: sql`${processingProfiles.version} + 1`,
                updatedBy: input.actor.actorId,
                updatedAt: now,
            })
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    eq(processingProfiles.channel, target.channel),
                    eq(processingProfiles.isDefault, true),
                    isNull(processingProfiles.archivedAt),
                ),
            );
        const changed = await tx
            .update(processingProfiles)
            .set({
                isDefault: true,
                version: sql`${processingProfiles.version} + 1`,
                updatedBy: input.actor.actorId,
                updatedAt: now,
            })
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    eq(processingProfiles.id, input.profileId),
                    isNull(processingProfiles.archivedAt),
                ),
            )
            .returning({ id: processingProfiles.id });
        return changed.length > 0;
    });
}

/** Archive an owner-scoped profile without changing its immutable revisions. */
export async function archiveProfile(
    input: ArchiveProfileInput,
): Promise<boolean> {
    return db.transaction(async (tx) => {
        const [current] = await tx
            .select({
                ownerUserId: processingProfiles.ownerUserId,
                scope: processingProfiles.scope,
                isDefault: processingProfiles.isDefault,
            })
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    eq(processingProfiles.id, input.profileId),
                    isNull(processingProfiles.archivedAt),
                ),
            )
            .for("update")
            .limit(1);
        if (!current) return false;
        await assertEditAccess(input.actor, current);
        if (current.isDefault) throw new DefaultProfileArchiveError();
        const archived = await tx
            .update(processingProfiles)
            .set({
                archivedAt: new Date(),
                isDefault: false,
                version: sql`${processingProfiles.version} + 1`,
                updatedBy: input.actor.actorId,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    eq(processingProfiles.id, input.profileId),
                    isNull(processingProfiles.archivedAt),
                ),
            )
            .returning({ id: processingProfiles.id });
        return archived.length > 0;
    });
}

/** Restore an archived owner-scoped profile without making it the default. */
export async function restoreProfile(
    input: RestoreProfileInput,
): Promise<boolean> {
    const [current] = await db
        .select({
            ownerUserId: processingProfiles.ownerUserId,
            scope: processingProfiles.scope,
        })
        .from(processingProfiles)
        .where(
            and(
                eq(processingProfiles.ownerUserId, input.ownerUserId),
                eq(processingProfiles.id, input.profileId),
                isNotNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!current) return false;
    await assertEditAccess(input.actor, current);
    const restored = await db
        .update(processingProfiles)
        .set({
            archivedAt: null,
            isDefault: false,
            version: sql`${processingProfiles.version} + 1`,
            updatedBy: input.actor.actorId,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(processingProfiles.ownerUserId, input.ownerUserId),
                eq(processingProfiles.id, input.profileId),
                isNotNull(processingProfiles.archivedAt),
            ),
        )
        .returning({ id: processingProfiles.id });
    return restored.length > 0;
}
