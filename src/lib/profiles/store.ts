import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import {
    aiEnhancements,
    folderDefaultProfiles,
    itemProcessing,
    learnRuns,
    processingProfileRevisions,
    processingProfiles,
    recordingFolders,
    transcriptions,
    userSettings,
} from "@/db/schema";
import type { ActorContext } from "@/lib/authz/model";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import {
    mayEditProfile,
    mayUseOrganizationProfiles,
    mayUseProfile,
} from "@/lib/profiles/access";
import { defaultProfileRule } from "@/lib/profiles/default-rule";
import { ensureProfiles } from "@/lib/profiles/seed";
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
        super("Choose another default profile before removing this one");
        this.name = "DefaultProfileArchiveError";
    }
}

/** An explicitly selected Organization profile can no longer be used. */
export class ExplicitDefaultProfileUnavailableError extends AppError {
    constructor() {
        super(
            ErrorCode.CONFLICT,
            "Your selected Organization profile is unavailable. Choose another default in Settings → Profiles.",
            409,
        );
        this.name = "ExplicitDefaultProfileUnavailableError";
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

async function getOwnedDefaultProfile(
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

export interface DefaultProfileState {
    channel: ProfileChannel;
    pointerId: string | null;
    personalDefault: ProfileRecord | null;
    organizationDefault: ProfileRecord | null;
    effective: ProfileRecord | null;
    source: "pointer" | "personal" | "organization" | "missing";
    explicitUnavailable: boolean;
}

function pointerFromSettings(
    settings: Pick<
        typeof userSettings.$inferSelect,
        "defaultAudioProfileId" | "defaultMailProfileId"
    > | null,
    channel: ProfileChannel,
): string | null {
    if (!settings) return null;
    return channel === "audio"
        ? settings.defaultAudioProfileId
        : settings.defaultMailProfileId;
}

async function pointedProfile(input: {
    ownerUserId: string;
    actorUserId: string;
    organizationUserId: string | null;
    channel: ProfileChannel;
    pointerId: string | null;
}): Promise<ProfileRecord | null> {
    if (!input.pointerId) return null;
    const personal = await getProfile(
        input.ownerUserId,
        input.pointerId,
        input.actorUserId,
    );
    if (personal?.channel === input.channel) return personal;
    if (!input.organizationUserId) return null;
    const organization = await getProfile(
        input.organizationUserId,
        input.pointerId,
        input.actorUserId,
    );
    return organization?.channel === input.channel ? organization : null;
}

/** Read the inputs and result of the authoritative member-default rule. */
export async function getDefaultProfileState(
    ownerUserId: string,
    channel: ProfileChannel,
    actorUserId = ownerUserId,
): Promise<DefaultProfileState> {
    await ensureProfiles(ownerUserId);
    const organizationUserId = await getOrgUserId();
    const organizationAccount = organizationUserId === ownerUserId;
    if (organizationAccount) {
        const organizationDefault = await getOwnedDefaultProfile(
            ownerUserId,
            channel,
            actorUserId,
        );
        return {
            channel,
            pointerId: null,
            personalDefault: null,
            organizationDefault,
            effective: organizationDefault,
            source: organizationDefault ? "organization" : "missing",
            explicitUnavailable: false,
        };
    }

    const [settings] = await db
        .select({
            defaultAudioProfileId: userSettings.defaultAudioProfileId,
            defaultMailProfileId: userSettings.defaultMailProfileId,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, ownerUserId))
        .limit(1);
    const pointerId = pointerFromSettings(settings ?? null, channel);
    const personalDefault = await getOwnedDefaultProfile(
        ownerUserId,
        channel,
        actorUserId,
    );
    const organizationAvailable =
        organizationUserId !== null &&
        isOrgScopeEnabled() &&
        (await mayUseOrganizationProfiles(actorUserId));
    if (organizationAvailable && organizationUserId) {
        await ensureProfiles(organizationUserId);
    }
    const organizationDefault =
        organizationAvailable && organizationUserId
            ? await getOwnedDefaultProfile(
                  organizationUserId,
                  channel,
                  actorUserId,
              )
            : null;
    const pointerProfile = await pointedProfile({
        ownerUserId,
        actorUserId,
        organizationUserId: organizationAvailable ? organizationUserId : null,
        channel,
        pointerId,
    });
    const rule = defaultProfileRule({
        pointerId,
        pointerProfileId: pointerProfile?.id ?? null,
        personalDefaultId: personalDefault?.id ?? null,
        organizationDefaultId: organizationDefault?.id ?? null,
    });
    if (rule.kind === "explicit_unavailable") {
        return {
            channel,
            pointerId,
            personalDefault,
            organizationDefault,
            effective: null,
            source: "missing",
            explicitUnavailable: true,
        };
    }
    if (rule.kind === "missing") {
        return {
            channel,
            pointerId,
            personalDefault,
            organizationDefault,
            effective: null,
            source: "missing",
            explicitUnavailable: false,
        };
    }
    const byId = new Map(
        [pointerProfile, personalDefault, organizationDefault]
            .filter((profile): profile is ProfileRecord => profile !== null)
            .map((profile) => [profile.id, profile]),
    );
    return {
        channel,
        pointerId,
        personalDefault,
        organizationDefault,
        effective: byId.get(rule.profileId) ?? null,
        source: rule.source,
        explicitUnavailable: false,
    };
}

/** Resolve the owner's live default profile using the member-default rule. */
export async function getDefaultProfile(
    ownerUserId: string,
    channel: ProfileChannel,
    actorUserId: string,
): Promise<ProfileRecord | null> {
    const state = await getDefaultProfileState(
        ownerUserId,
        channel,
        actorUserId,
    );
    if (state.explicitUnavailable) {
        throw new ExplicitDefaultProfileUnavailableError();
    }
    return state.effective;
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

export type ProfileDeleteDisposition = "delete" | "archive";

type ProfileQueryExecutor = Pick<typeof db, "select">;

async function profileHistoryReferences(
    executor: ProfileQueryExecutor,
    ownerUserId: string,
    profileId: string,
): Promise<boolean> {
    const revisions = await executor
        .select({ id: processingProfileRevisions.id })
        .from(processingProfileRevisions)
        .innerJoin(
            processingProfiles,
            and(
                eq(processingProfiles.id, processingProfileRevisions.profileId),
                eq(processingProfiles.ownerUserId, ownerUserId),
            ),
        )
        .where(eq(processingProfileRevisions.profileId, profileId));
    const revisionIds = revisions.map(({ id }) => id);
    const itemProfileReference =
        revisionIds.length > 0
            ? or(
                  eq(itemProcessing.profileId, profileId),
                  inArray(itemProcessing.profileRevisionId, revisionIds),
              )
            : eq(itemProcessing.profileId, profileId);
    const item = await executor
        .select({ id: itemProcessing.itemId })
        .from(itemProcessing)
        .where(
            and(eq(itemProcessing.userId, ownerUserId), itemProfileReference),
        )
        .limit(1);
    if (item.length > 0) return true;
    if (revisionIds.length === 0) return false;
    const [transcription, learn, enhancement] = await Promise.all([
        executor
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.userId, ownerUserId),
                    inArray(transcriptions.profileRevisionId, revisionIds),
                ),
            )
            .limit(1),
        executor
            .select({ id: learnRuns.id })
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.userId, ownerUserId),
                    inArray(learnRuns.profileRevisionId, revisionIds),
                ),
            )
            .limit(1),
        executor
            .select({ id: aiEnhancements.id })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.userId, ownerUserId),
                    inArray(aiEnhancements.profileRevisionId, revisionIds),
                ),
            )
            .limit(1),
    ]);
    return (
        transcription.length > 0 || learn.length > 0 || enhancement.length > 0
    );
}

/** Report whether deleting a personal profile preserves it as archived history. */
export async function profileDeleteDisposition(
    ownerUserId: string,
    profileId: string,
): Promise<ProfileDeleteDisposition | null> {
    const [profile] = await db
        .select({ id: processingProfiles.id, scope: processingProfiles.scope })
        .from(processingProfiles)
        .where(
            and(
                eq(processingProfiles.ownerUserId, ownerUserId),
                eq(processingProfiles.id, profileId),
                isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!profile || profile.scope !== "personal") return null;
    const [allProfiles, referenced] = await Promise.all([
        db
            .select({ id: processingProfiles.id })
            .from(processingProfiles)
            .where(eq(processingProfiles.ownerUserId, ownerUserId)),
        profileHistoryReferences(db, ownerUserId, profileId),
    ]);
    return referenced || allProfiles.length === 1 ? "archive" : "delete";
}

export interface DeletePersonalProfileResult {
    disposition: ProfileDeleteDisposition;
}

/** Delete an unused personal profile or archive it when history must survive. */
export async function deletePersonalProfile(
    input: ArchiveProfileInput,
): Promise<DeletePersonalProfileResult | null> {
    const state = await getDefaultProfileState(
        input.ownerUserId,
        "audio",
        input.actor.actorId,
    );
    const mailState = await getDefaultProfileState(
        input.ownerUserId,
        "mail",
        input.actor.actorId,
    );
    const [current] = await db
        .select({
            id: processingProfiles.id,
            channel: processingProfiles.channel,
            ownerUserId: processingProfiles.ownerUserId,
            scope: processingProfiles.scope,
        })
        .from(processingProfiles)
        .where(
            and(
                eq(processingProfiles.ownerUserId, input.ownerUserId),
                eq(processingProfiles.id, input.profileId),
                isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!current) return null;
    await assertEditAccess(input.actor, current);
    if (current.scope !== "personal") throw new ProfilePermissionError();
    const channelState = current.channel === "audio" ? state : mailState;
    const isCurrentDefault = channelState.effective?.id === current.id;
    if (isCurrentDefault && !channelState.organizationDefault) {
        throw new DefaultProfileArchiveError();
    }
    const disposition = await profileDeleteDisposition(
        input.ownerUserId,
        input.profileId,
    );
    if (!disposition) return null;

    return db.transaction(async (tx) => {
        const [locked] = await tx
            .select({ id: processingProfiles.id })
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    eq(processingProfiles.id, input.profileId),
                    eq(processingProfiles.scope, "personal"),
                    isNull(processingProfiles.archivedAt),
                ),
            )
            .for("update")
            .limit(1);
        if (!locked) return null;
        const actualDisposition = await profileHistoryReferences(
            tx,
            input.ownerUserId,
            input.profileId,
        );
        const [allProfiles] = await tx
            .select({ count: sql<number>`count(*)` })
            .from(processingProfiles)
            .where(eq(processingProfiles.ownerUserId, input.ownerUserId));
        const lockedDisposition =
            actualDisposition || Number(allProfiles?.count ?? 0) === 1
                ? "archive"
                : "delete";
        const folders = await tx
            .select({ id: folderDefaultProfiles.folderId })
            .from(folderDefaultProfiles)
            .innerJoin(
                recordingFolders,
                and(
                    eq(recordingFolders.id, folderDefaultProfiles.folderId),
                    eq(recordingFolders.userId, input.ownerUserId),
                ),
            )
            .where(eq(folderDefaultProfiles.profileId, input.profileId));
        if (folders.length > 0) {
            await tx
                .update(folderDefaultProfiles)
                .set({ profileId: null, manualOnly: false })
                .where(
                    and(
                        inArray(
                            folderDefaultProfiles.folderId,
                            folders.map(({ id }) => id),
                        ),
                        eq(folderDefaultProfiles.profileId, input.profileId),
                    ),
                );
        }
        if (isCurrentDefault) {
            await tx
                .update(processingProfiles)
                .set({ isDefault: false })
                .where(
                    and(
                        eq(processingProfiles.ownerUserId, input.ownerUserId),
                        eq(processingProfiles.channel, current.channel),
                        eq(processingProfiles.scope, "personal"),
                        eq(processingProfiles.isDefault, true),
                    ),
                );
        }
        if (current.channel === "audio") {
            await tx
                .update(userSettings)
                .set({ defaultAudioProfileId: null, updatedAt: new Date() })
                .where(
                    and(
                        eq(userSettings.userId, input.ownerUserId),
                        eq(userSettings.defaultAudioProfileId, input.profileId),
                    ),
                );
        } else {
            await tx
                .update(userSettings)
                .set({ defaultMailProfileId: null, updatedAt: new Date() })
                .where(
                    and(
                        eq(userSettings.userId, input.ownerUserId),
                        eq(userSettings.defaultMailProfileId, input.profileId),
                    ),
                );
        }
        if (lockedDisposition === "archive") {
            await tx
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
                    ),
                );
        } else {
            await tx
                .delete(processingProfiles)
                .where(
                    and(
                        eq(processingProfiles.ownerUserId, input.ownerUserId),
                        eq(processingProfiles.id, input.profileId),
                    ),
                );
        }
        return { disposition: lockedDisposition };
    });
}

export interface RestoreProfileInput {
    ownerUserId: string;
    profileId: string;
    actor: ActorContext;
}

export interface SetDefaultProfileInput {
    ownerUserId: string;
    profileId: string | null;
    channel?: ProfileChannel;
    actor: ActorContext;
}

async function defaultSelectionTarget(input: SetDefaultProfileInput): Promise<{
    channel: ProfileChannel;
    profile: ProfileRecord | null;
    organizationUserId: string | null;
}> {
    if (input.actor.kind !== "user") throw new ProfilePermissionError();
    const organizationUserId = await getOrgUserId();
    if (input.actor.actorId !== input.ownerUserId) {
        if (!input.profileId || organizationUserId !== input.ownerUserId) {
            throw new ProfilePermissionError();
        }
        const organization = await getProfile(
            input.ownerUserId,
            input.profileId,
            input.actor.actorId,
        );
        if (!organization) throw new ProfilePermissionError();
        await assertEditAccess(input.actor, organization);
        return {
            channel: organization.channel,
            profile: organization,
            organizationUserId,
        };
    }
    if (!input.profileId) {
        if (!input.channel || organizationUserId === input.ownerUserId) {
            throw new ProfilePermissionError();
        }
        const state = await getDefaultProfileState(
            input.ownerUserId,
            input.channel,
            input.actor.actorId,
        );
        if (!state.organizationDefault) throw new ProfilePermissionError();
        return {
            channel: input.channel,
            profile: null,
            organizationUserId,
        };
    }

    const personal = await getProfile(
        input.ownerUserId,
        input.profileId,
        input.actor.actorId,
    );
    if (personal) {
        if (input.channel && input.channel !== personal.channel) {
            throw new ProfilePermissionError();
        }
        return {
            channel: personal.channel,
            profile: personal,
            organizationUserId,
        };
    }
    if (!organizationUserId) throw new ProfilePermissionError();
    const organization = await getProfile(
        organizationUserId,
        input.profileId,
        input.actor.actorId,
    );
    if (
        !organization ||
        (input.channel && input.channel !== organization.channel)
    ) {
        throw new ProfilePermissionError();
    }
    return {
        channel: organization.channel,
        profile: organization,
        organizationUserId,
    };
}

/** Atomically write a member or Organization channel default and its legacy mirror. */
export async function setDefaultProfile(
    input: SetDefaultProfileInput,
): Promise<boolean> {
    const target = await defaultSelectionTarget(input);
    return db.transaction(async (tx) => {
        await tx
            .insert(userSettings)
            .values({ userId: input.ownerUserId })
            .onConflictDoNothing({ target: userSettings.userId });
        await tx
            .select({ id: userSettings.id })
            .from(userSettings)
            .where(eq(userSettings.userId, input.ownerUserId))
            .for("update");
        await tx
            .select({ id: processingProfiles.id })
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    eq(processingProfiles.channel, target.channel),
                ),
            )
            .orderBy(processingProfiles.id)
            .for("update");
        const now = new Date();
        const organizationAccount =
            target.organizationUserId === input.ownerUserId;
        if (organizationAccount) {
            if (
                !target.profile ||
                target.profile.ownerUserId !== input.ownerUserId ||
                target.profile.scope !== "organization"
            ) {
                throw new ProfilePermissionError();
            }
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
                        eq(processingProfiles.id, target.profile.id),
                        isNull(processingProfiles.archivedAt),
                    ),
                )
                .returning({ id: processingProfiles.id });
            return changed.length > 0;
        }

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
                    eq(processingProfiles.scope, "personal"),
                    eq(processingProfiles.channel, target.channel),
                    eq(processingProfiles.isDefault, true),
                    isNull(processingProfiles.archivedAt),
                ),
            );

        let pointerId: string | null = null;
        if (target.profile?.scope === "personal") {
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
                        eq(processingProfiles.id, target.profile.id),
                        eq(processingProfiles.channel, target.channel),
                        isNull(processingProfiles.archivedAt),
                    ),
                )
                .returning({ id: processingProfiles.id });
            if (changed.length === 0) return false;
        } else if (target.profile) {
            pointerId = target.profile.id;
        }

        const pointerUpdate =
            target.channel === "audio"
                ? { defaultAudioProfileId: pointerId, updatedAt: now }
                : { defaultMailProfileId: pointerId, updatedAt: now };
        await tx
            .insert(userSettings)
            .values({ userId: input.ownerUserId, ...pointerUpdate })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: pointerUpdate,
            });
        return true;
    });
}

/** Archive an owner-scoped profile without changing its immutable revisions. */
export async function archiveProfile(
    input: ArchiveProfileInput,
): Promise<boolean> {
    const [candidate] = await db
        .select({
            id: processingProfiles.id,
            channel: processingProfiles.channel,
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
        .limit(1);
    if (!candidate) return false;
    await assertEditAccess(input.actor, candidate);
    const defaultState =
        candidate.scope === "personal"
            ? await getDefaultProfileState(
                  input.ownerUserId,
                  candidate.channel,
                  input.actor.actorId,
              )
            : null;
    const switchesToOrganization = defaultState?.effective?.id === candidate.id;
    if (switchesToOrganization && !defaultState.organizationDefault) {
        throw new DefaultProfileArchiveError();
    }
    if (candidate.scope === "organization" && candidate.isDefault) {
        throw new DefaultProfileArchiveError();
    }

    return db.transaction(async (tx) => {
        const [current] = await tx
            .select({
                channel: processingProfiles.channel,
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
        if (current.scope === "organization" && current.isDefault) {
            throw new DefaultProfileArchiveError();
        }
        if (switchesToOrganization) {
            await tx
                .update(processingProfiles)
                .set({ isDefault: false })
                .where(
                    and(
                        eq(processingProfiles.ownerUserId, input.ownerUserId),
                        eq(processingProfiles.channel, current.channel),
                        eq(processingProfiles.scope, "personal"),
                        eq(processingProfiles.isDefault, true),
                    ),
                );
            const pointerUpdate =
                current.channel === "audio"
                    ? { defaultAudioProfileId: null, updatedAt: new Date() }
                    : { defaultMailProfileId: null, updatedAt: new Date() };
            await tx
                .update(userSettings)
                .set(pointerUpdate)
                .where(eq(userSettings.userId, input.ownerUserId));
        }
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
