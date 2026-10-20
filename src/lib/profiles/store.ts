import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import { profileHistoryReferences } from "@/db/queries/profile-history";
import { lockProfileMutation } from "@/db/queries/profile-mutations";
import {
    folderDefaultProfiles,
    processingProfileRevisions,
    processingProfiles,
    userSettings,
} from "@/db/schema";
import type { HolderAccess } from "@/lib/authz/access-state";
import type { ActorContext } from "@/lib/authz/model";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import type { AppLocale } from "@/lib/i18n/config";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import {
    mayEditProfile,
    mayUseOrganizationProfiles,
    mayUseProfile,
} from "@/lib/profiles/access";
import { defaultProfileRule } from "@/lib/profiles/default-rule";
import { validateProfileProviderPins } from "@/lib/profiles/providers";
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
                isNull(processingProfiles.deletedAt),
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

async function actorProfiles(
    input: ListActorProfilesInput & { includeArchived?: boolean },
): Promise<ProfileRecord[]> {
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
                isNull(processingProfiles.deletedAt),
                input.includeArchived
                    ? undefined
                    : input.archivedOnly
                      ? isNotNull(processingProfiles.archivedAt)
                      : isNull(processingProfiles.archivedAt),
            ),
        )
        .orderBy(asc(processingProfiles.createdAt), asc(processingProfiles.id));
    const search = input.search?.trim().toLocaleLowerCase();
    const permitted = await Promise.all(
        rows.map(async (row) => {
            const profile = present(row);
            if (!(await mayUseProfile(actorUserId, profile))) return null;
            if (
                profile.archivedAt &&
                profile.scope === "organization" &&
                !(await mayEditProfile(input.actor, profile))
            )
                return null;
            return profile;
        }),
    );
    return permitted.filter(
        (profile): profile is ProfileRecord =>
            profile !== null &&
            (!input.channel || profile.channel === input.channel) &&
            (!input.scope || profile.scope === input.scope) &&
            (!search ||
                profile.name.toLocaleLowerCase().includes(search) ||
                (profile.description?.toLocaleLowerCase().includes(search) ??
                    false)),
    );
}

/** List the actor's personal profiles and Organization profiles they may use. */
export async function listActorProfiles(
    input: ListActorProfilesInput,
): Promise<ProfilePage> {
    const filtered = await actorProfiles(input);
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(100, Math.max(1, input.limit ?? 25));
    return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
    };
}

export type ProfileSection = "organization" | "personal" | "archived";

/** Filter once and paginate each visible profile section independently. */
export async function listActorProfileSections(input: {
    actor: ActorContext;
    search?: string;
    channel?: ProfileChannel;
    pages: Record<ProfileSection, number>;
    limit: number;
}): Promise<Record<ProfileSection, ProfilePage>> {
    const profiles = await actorProfiles({ ...input, includeArchived: true });
    const limit = Math.min(100, Math.max(1, input.limit));
    function section(key: ProfileSection): ProfilePage {
        const filtered = profiles.filter((profile) =>
            key === "archived"
                ? profile.archivedAt !== null
                : profile.archivedAt === null && profile.scope === key,
        );
        const page = Math.min(
            Math.max(1, input.pages[key]),
            Math.max(1, Math.ceil(filtered.length / limit)),
        );
        const offset = (page - 1) * limit;
        return {
            items: filtered.slice(offset, offset + limit),
            total: filtered.length,
            offset,
            limit,
        };
    }
    return {
        organization: section("organization"),
        personal: section("personal"),
        archived: section("archived"),
    };
}

/** Read one profile only through its owner. */
export async function getProfile(
    ownerUserId: string,
    profileId: string,
    actorUserId: string,
    options: {
        includeArchived?: boolean;
        readOnly?: boolean;
        readOnlyAccess?: () => Promise<HolderAccess>;
    } = {},
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
                isNull(processingProfiles.deletedAt),
                options.includeArchived
                    ? undefined
                    : isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!row) return null;
    const profile = present(row);
    return (await mayUseProfile(actorUserId, profile, options))
        ? profile
        : null;
}

async function getOwnedDefaultProfile(
    ownerUserId: string,
    channel: ProfileChannel,
    actorUserId: string,
    options: {
        readOnly?: boolean;
        readOnlyAccess?: () => Promise<HolderAccess>;
    } = {},
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
                isNull(processingProfiles.deletedAt),
                isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!row) return null;
    const profile = present(row);
    return (await mayUseProfile(actorUserId, profile, options))
        ? profile
        : null;
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
    readOnly?: boolean;
    readOnlyAccess?: () => Promise<HolderAccess>;
}): Promise<ProfileRecord | null> {
    if (!input.pointerId) return null;
    const personal = await getProfile(
        input.ownerUserId,
        input.pointerId,
        input.actorUserId,
        { readOnly: input.readOnly, readOnlyAccess: input.readOnlyAccess },
    );
    if (personal?.channel === input.channel) return personal;
    if (!input.organizationUserId) return null;
    const organization = await getProfile(
        input.organizationUserId,
        input.pointerId,
        input.actorUserId,
        { readOnly: input.readOnly, readOnlyAccess: input.readOnlyAccess },
    );
    return organization?.channel === input.channel ? organization : null;
}

/** Read the member-default rule; disabling seeding also disables authorization-cache writes. */
export async function getDefaultProfileState(
    ownerUserId: string,
    channel: ProfileChannel,
    actorUserId = ownerUserId,
    options: {
        seed?: boolean;
        readOnlyAccess?: () => Promise<HolderAccess>;
    } = {},
): Promise<DefaultProfileState> {
    const accessOptions = {
        readOnly: options.seed === false,
        readOnlyAccess: options.readOnlyAccess,
    };
    if (options.seed !== false) await ensureProfiles(ownerUserId);
    const organizationUserId = await getOrgUserId();
    const organizationAccount = organizationUserId === ownerUserId;
    if (organizationAccount) {
        const organizationDefault = await getOwnedDefaultProfile(
            ownerUserId,
            channel,
            actorUserId,
            accessOptions,
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
        accessOptions,
    );
    const organizationAvailable =
        organizationUserId !== null &&
        isOrgScopeEnabled() &&
        (await mayUseOrganizationProfiles(actorUserId, accessOptions));
    if (options.seed !== false && organizationAvailable && organizationUserId) {
        await ensureProfiles(organizationUserId);
    }
    const organizationDefault =
        organizationAvailable && organizationUserId
            ? await getOwnedDefaultProfile(
                  organizationUserId,
                  channel,
                  actorUserId,
                  accessOptions,
              )
            : null;
    const pointerProfile = await pointedProfile({
        ownerUserId,
        actorUserId,
        organizationUserId: organizationAvailable ? organizationUserId : null,
        channel,
        pointerId,
        readOnly: accessOptions.readOnly,
        readOnlyAccess: accessOptions.readOnlyAccess,
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
        await lockProfileMutation(tx, input.ownerUserId);
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
        await lockProfileMutation(tx, input.ownerUserId);
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
                    isNull(processingProfiles.deletedAt),
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
                    isNull(processingProfiles.deletedAt),
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
    scope?: ProfileScope;
    locale?: AppLocale;
}

/** Copy an available current revision into an authorized destination scope. */
export async function duplicateProfile(
    input: DuplicateProfileInput,
): Promise<ProfileRecord> {
    const scope = input.scope ?? "personal";
    if (scope === "personal" && input.actor.kind !== "user")
        throw new ProfilePermissionError();
    const ownerUserId =
        scope === "organization" ? await getOrgUserId() : input.actor.actorId;
    if (!ownerUserId) throw new ProfilePermissionError();
    await assertCreateAccess(input.actor, ownerUserId, scope);
    const source = await getProfile(
        input.sourceOwnerUserId,
        input.profileId,
        input.actor.actorId,
    );
    if (!source) {
        throw new ProfilePermissionError();
    }
    await validateProfileProviderPins({
        actorUserId: input.actor.actorId,
        profileOwnerUserId: ownerUserId,
        profileScope: scope,
        settings: source.settings,
    });
    return createProfile({
        ownerUserId,
        actor: input.actor,
        scope,
        channel: source.channel,
        name:
            input.name ??
            `${source.name} (${input.locale === "cs-CZ" ? "kopie" : "copy"})`,
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

export type ProfileDeleteDisposition = "delete" | "tombstone";

type ProfileRemovalExecutor = Pick<typeof db, "select" | "update">;

interface ProfileRemovalFallbackInput {
    ownerUserId: string;
    profileId: string;
    actorUserId: string;
    organizationUserId: string | null;
    organizationAvailable: boolean;
    settings: Pick<
        typeof userSettings.$inferSelect,
        "defaultAudioProfileId" | "defaultMailProfileId"
    > | null;
    profile: Pick<
        StoredProfile,
        "channel" | "ownerUserId" | "scope" | "isDefault"
    >;
}

async function applyOrganizationFallbackForProfileRemoval(
    executor: ProfileRemovalExecutor,
    input: ProfileRemovalFallbackInput,
): Promise<void> {
    if (input.profile.scope === "organization" && input.profile.isDefault) {
        throw new DefaultProfileArchiveError();
    }
    const pointerId = pointerFromSettings(
        input.settings,
        input.profile.channel,
    );
    const switchesToOrganization =
        input.profile.scope === "personal" &&
        (pointerId === input.profileId ||
            (pointerId === null && input.profile.isDefault));
    if (!switchesToOrganization) return;

    let organizationDefault:
        | Pick<StoredProfile, "id" | "ownerUserId" | "scope">
        | undefined;
    if (input.organizationAvailable && input.organizationUserId) {
        [organizationDefault] = await executor
            .select({
                id: processingProfiles.id,
                ownerUserId: processingProfiles.ownerUserId,
                scope: processingProfiles.scope,
            })
            .from(processingProfiles)
            .where(
                and(
                    eq(
                        processingProfiles.ownerUserId,
                        input.organizationUserId,
                    ),
                    eq(processingProfiles.scope, "organization"),
                    eq(processingProfiles.channel, input.profile.channel),
                    eq(processingProfiles.isDefault, true),
                    isNull(processingProfiles.deletedAt),
                    isNull(processingProfiles.archivedAt),
                ),
            )
            .for("update")
            .limit(1);
    }
    if (
        !organizationDefault ||
        !(await mayUseProfile(input.actorUserId, organizationDefault))
    ) {
        throw new DefaultProfileArchiveError();
    }
    await executor
        .update(processingProfiles)
        .set({ isDefault: false })
        .where(
            and(
                eq(processingProfiles.ownerUserId, input.ownerUserId),
                eq(processingProfiles.channel, input.profile.channel),
                eq(processingProfiles.scope, "personal"),
                eq(processingProfiles.isDefault, true),
            ),
        );
    if (input.profile.channel === "audio") {
        await executor
            .update(userSettings)
            .set({
                defaultAudioProfileId: null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(userSettings.userId, input.ownerUserId),
                    eq(userSettings.defaultAudioProfileId, input.profileId),
                ),
            );
        return;
    }
    await executor
        .update(userSettings)
        .set({
            defaultMailProfileId: null,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(userSettings.userId, input.ownerUserId),
                eq(userSettings.defaultMailProfileId, input.profileId),
            ),
        );
}

/**
 * Report whether deleting an owner-scoped personal profile preserves it as
 * tombstoned history. Ownership establishes the opaque profile and revision
 * IDs; references owned by other users are checked only by those opaque IDs.
 */
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
                isNull(processingProfiles.deletedAt),
                isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!profile || profile.scope !== "personal") return null;
    return (await profileHistoryReferences(db, ownerUserId, profileId))
        ? "tombstone"
        : "delete";
}

/** Count member default pointers that refer to one Organization profile. */
export async function profileMemberDefaultCount(
    ownerUserId: string,
    profileId: string,
): Promise<number | null> {
    const [profile] = await db
        .select({ id: processingProfiles.id })
        .from(processingProfiles)
        .where(
            and(
                eq(processingProfiles.ownerUserId, ownerUserId),
                eq(processingProfiles.id, profileId),
                eq(processingProfiles.scope, "organization"),
                isNull(processingProfiles.deletedAt),
                isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!profile) return null;
    const [result] = await db
        .select({ count: sql<number>`count(*)` })
        .from(userSettings)
        .where(
            and(
                sql`${userSettings.userId} <> ${ownerUserId}`,
                or(
                    eq(userSettings.defaultAudioProfileId, profileId),
                    eq(userSettings.defaultMailProfileId, profileId),
                ),
            ),
        );
    return Number(result?.count ?? 0);
}

export interface DeletePersonalProfileResult {
    disposition: ProfileDeleteDisposition;
}

/** Permanently remove an authorized profile, retaining referenced revisions as history. */
export async function deleteProfile(
    input: ArchiveProfileInput,
): Promise<DeletePersonalProfileResult | null> {
    const organizationUserId = await getOrgUserId();
    const organizationAvailable =
        organizationUserId !== null &&
        organizationUserId !== input.ownerUserId &&
        isOrgScopeEnabled() &&
        (await mayUseOrganizationProfiles(input.actor.actorId));
    if (organizationAvailable && organizationUserId) {
        await ensureProfiles(organizationUserId);
    }
    return db.transaction(async (tx) => {
        await lockProfileMutation(tx, input.ownerUserId);
        await tx
            .insert(userSettings)
            .values({ userId: input.ownerUserId })
            .onConflictDoNothing({ target: userSettings.userId });
        const [settings] = await tx
            .select({
                id: userSettings.id,
                defaultAudioProfileId: userSettings.defaultAudioProfileId,
                defaultMailProfileId: userSettings.defaultMailProfileId,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, input.ownerUserId))
            .for("update");
        const [current] = await tx
            .select()
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    eq(processingProfiles.id, input.profileId),
                    isNull(processingProfiles.deletedAt),
                ),
            )
            .for("update")
            .limit(1);
        if (!current) return null;
        await assertEditAccess(input.actor, current);
        if (
            current.scope === "organization" &&
            (current.isDefault || !current.archivedAt)
        ) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "Only archived, non-default Organization profiles can be deleted permanently",
                409,
            );
        }
        if (current.scope === "personal") {
            await applyOrganizationFallbackForProfileRemoval(tx, {
                ownerUserId: input.ownerUserId,
                profileId: input.profileId,
                actorUserId: input.actor.actorId,
                organizationUserId,
                organizationAvailable,
                settings: settings ?? null,
                profile: current,
            });
        }
        const now = new Date();
        await tx
            .update(userSettings)
            .set({ defaultAudioProfileId: null, updatedAt: now })
            .where(eq(userSettings.defaultAudioProfileId, input.profileId));
        await tx
            .update(userSettings)
            .set({ defaultMailProfileId: null, updatedAt: now })
            .where(eq(userSettings.defaultMailProfileId, input.profileId));
        await tx
            .update(folderDefaultProfiles)
            .set({ profileId: null, manualOnly: false })
            .where(eq(folderDefaultProfiles.profileId, input.profileId));
        const referenced = await profileHistoryReferences(
            tx,
            input.ownerUserId,
            input.profileId,
        );
        if (referenced) {
            await tx
                .update(processingProfiles)
                .set({
                    deletedAt: now,
                    isDefault: false,
                    version: sql`${processingProfiles.version} + 1`,
                    updatedBy: input.actor.actorId,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(processingProfiles.ownerUserId, input.ownerUserId),
                        eq(processingProfiles.id, input.profileId),
                        isNull(processingProfiles.deletedAt),
                    ),
                );
        } else {
            await tx
                .delete(processingProfiles)
                .where(
                    and(
                        eq(processingProfiles.ownerUserId, input.ownerUserId),
                        eq(processingProfiles.id, input.profileId),
                        isNull(processingProfiles.deletedAt),
                    ),
                );
        }
        return { disposition: referenced ? "tombstone" : "delete" };
    });
}

/** Delete a personal profile under the same history-preserving rule. */
export async function deletePersonalProfile(
    input: ArchiveProfileInput,
): Promise<DeletePersonalProfileResult | null> {
    const [profile] = await db
        .select({ scope: processingProfiles.scope })
        .from(processingProfiles)
        .where(
            and(
                eq(processingProfiles.ownerUserId, input.ownerUserId),
                eq(processingProfiles.id, input.profileId),
                isNull(processingProfiles.deletedAt),
            ),
        )
        .limit(1);
    if (!profile) return null;
    if (profile.scope !== "personal") throw new ProfilePermissionError();
    return deleteProfile(input);
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

/** Atomically write a member or Organization channel default and its legacy mirror. */
export async function setDefaultProfile(
    input: SetDefaultProfileInput,
): Promise<boolean> {
    if (input.actor.kind !== "user" && input.actor.kind !== "local-org")
        throw new ProfilePermissionError();
    const organizationUserId = await getOrgUserId();
    return db.transaction(async (tx) => {
        for (const owner of [
            ...new Set([
                input.ownerUserId,
                ...(organizationUserId ? [organizationUserId] : []),
            ]),
        ].sort()) {
            await lockProfileMutation(tx, owner);
        }
        await tx
            .insert(userSettings)
            .values({ userId: input.ownerUserId })
            .onConflictDoNothing({ target: userSettings.userId });
        await tx
            .select({ id: userSettings.id })
            .from(userSettings)
            .where(eq(userSettings.userId, input.ownerUserId))
            .for("update");

        let channel: ProfileChannel;
        let lockedTarget:
            | Pick<StoredProfile, "id" | "ownerUserId" | "scope" | "channel">
            | undefined;
        if (input.profileId) {
            const ownerCondition = organizationUserId
                ? or(
                      eq(processingProfiles.ownerUserId, input.ownerUserId),
                      eq(processingProfiles.ownerUserId, organizationUserId),
                  )
                : eq(processingProfiles.ownerUserId, input.ownerUserId);
            [lockedTarget] = await tx
                .select({
                    id: processingProfiles.id,
                    ownerUserId: processingProfiles.ownerUserId,
                    scope: processingProfiles.scope,
                    channel: processingProfiles.channel,
                })
                .from(processingProfiles)
                .where(
                    and(
                        ownerCondition,
                        eq(processingProfiles.id, input.profileId),
                        isNull(processingProfiles.deletedAt),
                        isNull(processingProfiles.archivedAt),
                    ),
                )
                .for("update")
                .limit(1);
            if (!lockedTarget) {
                throw new ProfilePermissionError();
            }
            const isOwned = lockedTarget.ownerUserId === input.ownerUserId;
            const isOrganization =
                lockedTarget.ownerUserId === organizationUserId &&
                lockedTarget.scope === "organization";
            if (!isOwned && !isOrganization) {
                throw new ProfilePermissionError();
            }
            if (input.actor.actorId !== input.ownerUserId) {
                if (
                    organizationUserId !== input.ownerUserId ||
                    lockedTarget.scope !== "organization"
                ) {
                    throw new ProfilePermissionError();
                }
                await assertEditAccess(input.actor, lockedTarget);
            }
            if (!(await mayUseProfile(input.actor.actorId, lockedTarget))) {
                throw new ProfilePermissionError();
            }
            if (input.channel && input.channel !== lockedTarget.channel) {
                throw new ProfilePermissionError();
            }
            channel = lockedTarget.channel;
        } else {
            if (
                input.actor.actorId !== input.ownerUserId ||
                !input.channel ||
                !organizationUserId ||
                organizationUserId === input.ownerUserId
            ) {
                throw new ProfilePermissionError();
            }
            channel = input.channel;
            const [organizationDefault] = await tx
                .select({
                    id: processingProfiles.id,
                    ownerUserId: processingProfiles.ownerUserId,
                    scope: processingProfiles.scope,
                    channel: processingProfiles.channel,
                })
                .from(processingProfiles)
                .where(
                    and(
                        eq(processingProfiles.ownerUserId, organizationUserId),
                        eq(processingProfiles.scope, "organization"),
                        eq(processingProfiles.channel, channel),
                        eq(processingProfiles.isDefault, true),
                        isNull(processingProfiles.deletedAt),
                        isNull(processingProfiles.archivedAt),
                    ),
                )
                .for("update")
                .limit(1);
            if (
                !organizationDefault ||
                !(await mayUseProfile(input.actor.actorId, organizationDefault))
            ) {
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Organization default profile is unavailable",
                    404,
                );
            }
        }
        await tx
            .select({ id: processingProfiles.id })
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    eq(processingProfiles.channel, channel),
                ),
            )
            .orderBy(processingProfiles.id)
            .for("update");
        const now = new Date();
        const organizationAccount = organizationUserId === input.ownerUserId;
        if (organizationAccount) {
            if (
                !lockedTarget ||
                lockedTarget.ownerUserId !== input.ownerUserId ||
                lockedTarget.scope !== "organization"
            ) {
                throw new ProfilePermissionError();
            }
            await assertEditAccess(input.actor, lockedTarget);
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
                        eq(processingProfiles.channel, channel),
                        eq(processingProfiles.isDefault, true),
                        isNull(processingProfiles.deletedAt),
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
                        eq(processingProfiles.id, lockedTarget.id),
                        isNull(processingProfiles.deletedAt),
                        isNull(processingProfiles.archivedAt),
                    ),
                )
                .returning({ id: processingProfiles.id });
            if (changed.length === 0) {
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Profile not found",
                    404,
                );
            }
            return true;
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
                    eq(processingProfiles.channel, channel),
                    eq(processingProfiles.isDefault, true),
                    isNull(processingProfiles.deletedAt),
                    isNull(processingProfiles.archivedAt),
                ),
            );

        let pointerId: string | null = null;
        if (lockedTarget?.scope === "personal") {
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
                        eq(processingProfiles.id, lockedTarget.id),
                        eq(processingProfiles.channel, channel),
                        isNull(processingProfiles.deletedAt),
                        isNull(processingProfiles.archivedAt),
                    ),
                )
                .returning({ id: processingProfiles.id });
            if (changed.length === 0) {
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Profile not found",
                    404,
                );
            }
        } else if (lockedTarget) {
            pointerId = lockedTarget.id;
        }

        const pointerUpdate =
            channel === "audio"
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
            ownerUserId: processingProfiles.ownerUserId,
            scope: processingProfiles.scope,
        })
        .from(processingProfiles)
        .where(
            and(
                eq(processingProfiles.ownerUserId, input.ownerUserId),
                eq(processingProfiles.id, input.profileId),
                isNull(processingProfiles.deletedAt),
                isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!candidate) return false;
    await assertEditAccess(input.actor, candidate);
    const organizationUserId = await getOrgUserId();
    const organizationAvailable =
        candidate.scope === "personal" &&
        organizationUserId !== null &&
        organizationUserId !== input.ownerUserId &&
        isOrgScopeEnabled() &&
        (await mayUseOrganizationProfiles(input.actor.actorId));
    if (organizationAvailable && organizationUserId) {
        await ensureProfiles(organizationUserId);
    }

    return db.transaction(async (tx) => {
        await lockProfileMutation(tx, input.ownerUserId);
        await tx
            .insert(userSettings)
            .values({ userId: input.ownerUserId })
            .onConflictDoNothing({ target: userSettings.userId });
        const [settings] = await tx
            .select({
                id: userSettings.id,
                defaultAudioProfileId: userSettings.defaultAudioProfileId,
                defaultMailProfileId: userSettings.defaultMailProfileId,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, input.ownerUserId))
            .for("update")
            .limit(1);
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
                    isNull(processingProfiles.deletedAt),
                    isNull(processingProfiles.archivedAt),
                ),
            )
            .for("update")
            .limit(1);
        if (!current) return false;
        await assertEditAccess(input.actor, current);
        await applyOrganizationFallbackForProfileRemoval(tx, {
            ownerUserId: input.ownerUserId,
            profileId: input.profileId,
            actorUserId: input.actor.actorId,
            organizationUserId,
            organizationAvailable,
            settings: settings ?? null,
            profile: current,
        });
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
                    isNull(processingProfiles.deletedAt),
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
    return db.transaction(async (tx) => {
        await lockProfileMutation(tx, input.ownerUserId);
        const [current] = await tx
            .select({
                ownerUserId: processingProfiles.ownerUserId,
                scope: processingProfiles.scope,
            })
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, input.ownerUserId),
                    eq(processingProfiles.id, input.profileId),
                    isNull(processingProfiles.deletedAt),
                    isNotNull(processingProfiles.archivedAt),
                ),
            )
            .limit(1);
        if (!current) return false;
        await assertEditAccess(input.actor, current);
        const restored = await tx
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
                    isNull(processingProfiles.deletedAt),
                    isNotNull(processingProfiles.archivedAt),
                ),
            )
            .returning({ id: processingProfiles.id });
        return restored.length > 0;
    });
}
