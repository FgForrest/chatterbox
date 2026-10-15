import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { folderDefaultProfiles, recordingFolders } from "@/db/schema";
import { requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import {
    type FolderDefaultProfileDetails,
    folderDefaultProfileDetails,
} from "@/lib/profiles/resolve-for-placement";
import { ensureProfiles } from "@/lib/profiles/seed";
import {
    type ProfileChannel,
    profileChannelSchema,
} from "@/lib/profiles/settings";
import {
    getDefaultProfile,
    getProfile,
    type ProfileRecord,
} from "@/lib/profiles/store";

type IdContext = { params: Promise<{ id: string }> };

const updateSchema = z
    .object({
        channel: profileChannelSchema,
        profileId: z.string().min(1).nullable(),
        manualOnly: z.boolean().optional().default(false),
    })
    .strict()
    .refine(({ profileId, manualOnly }) => !(profileId && manualOnly), {
        message: "profileId and manualOnly are mutually exclusive",
    });

interface AccessibleFolder {
    id: string;
    ownerUserId: string;
    parentId: string | null;
    scope: "personal" | "org";
}

function folderNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
}

function rootRefused(): AppError {
    return new AppError(
        ErrorCode.INVALID_INPUT,
        "Root folders cannot have default profiles",
        400,
    );
}

async function accessibleFolder(
    actorUserId: string,
    folderId: string,
): Promise<AccessibleFolder> {
    const organizationUserId = await getOrgUserId();
    const ownerIds = [
        actorUserId,
        ...(organizationUserId && organizationUserId !== actorUserId
            ? [organizationUserId]
            : []),
    ];
    for (const ownerUserId of ownerIds) {
        const [folder] = await db
            .select({
                id: recordingFolders.id,
                ownerUserId: recordingFolders.userId,
                parentId: recordingFolders.parentId,
            })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.id, folderId),
                    eq(recordingFolders.userId, ownerUserId),
                ),
            )
            .limit(1);
        if (!folder) continue;
        const scope =
            organizationUserId === folder.ownerUserId ? "org" : "personal";
        if (scope === "org" && !isOrgScopeEnabled()) throw folderNotFound();
        return { ...folder, scope };
    }
    throw folderNotFound();
}

function profileSummary(profile: ProfileRecord | null) {
    return profile
        ? {
              id: profile.id,
              name: profile.name,
              scope: profile.scope,
              channel: profile.channel,
          }
        : null;
}

async function channelDefaults(
    folder: AccessibleFolder,
    actorUserId: string,
    channel: ProfileChannel,
) {
    const defaults = (await folderDefaultProfileDetails({
        folderId: folder.id,
        folderOwnerUserId: folder.ownerUserId,
        actorUserId,
        channel,
        organizationOnly: folder.scope === "org",
    })) satisfies FolderDefaultProfileDetails | null;
    const inherited = folder.parentId
        ? await folderDefaultProfileDetails({
              folderId: folder.parentId,
              folderOwnerUserId: folder.ownerUserId,
              actorUserId,
              channel,
              organizationOnly: folder.scope === "org",
          })
        : null;
    await ensureProfiles(folder.ownerUserId);
    const accountDefault =
        folder.scope === "personal"
            ? await getDefaultProfile(folder.ownerUserId, channel, actorUserId)
            : null;
    const inheritedFolder = defaults?.inheritedFromFolderId
        ? await db
              .select({ name: recordingFolders.name })
              .from(recordingFolders)
              .where(
                  and(
                      eq(recordingFolders.id, defaults.inheritedFromFolderId),
                      eq(recordingFolders.userId, folder.ownerUserId),
                  ),
              )
              .limit(1)
        : [];
    return {
        own: profileSummary(defaults?.own ?? null),
        ownManualOnly: defaults?.ownManualOnly ?? false,
        effective: profileSummary(defaults?.effective ?? null),
        effectiveManualOnly: defaults?.effectiveManualOnly ?? false,
        inheritedFromFolderId: defaults?.inheritedFromFolderId ?? null,
        inheritedFromFolderName: inheritedFolder[0]
            ? decryptText(inheritedFolder[0].name)
            : null,
        inherited: profileSummary(inherited?.effective ?? null),
        inheritedManualOnly: inherited?.effectiveManualOnly ?? false,
        accountDefault: profileSummary(accountDefault),
    };
}

async function responseBody(
    folder: AccessibleFolder,
    actorUserId: string,
    canEdit: boolean,
) {
    const [audio, mail] = await Promise.all([
        channelDefaults(folder, actorUserId, "audio"),
        channelDefaults(folder, actorUserId, "mail"),
    ]);
    return {
        scope: folder.scope,
        canEdit,
        defaults: { audio, mail },
    };
}

async function mayEditFolderDefault(
    folder: AccessibleFolder,
    actor: Parameters<typeof actsForOrganization>[0],
): Promise<boolean> {
    return folder.scope === "personal"
        ? actor.kind === "user" && actor.actorId === folder.ownerUserId
        : actsForOrganization(actor);
}

async function selectedProfile(input: {
    folder: AccessibleFolder;
    actorUserId: string;
    profileId: string;
    channel: ProfileChannel;
}): Promise<ProfileRecord> {
    const organizationUserId = await getOrgUserId();
    const ownerIds =
        input.folder.scope === "org"
            ? organizationUserId
                ? [organizationUserId]
                : []
            : [
                  input.folder.ownerUserId,
                  ...(organizationUserId &&
                  organizationUserId !== input.folder.ownerUserId
                      ? [organizationUserId]
                      : []),
              ];
    for (const ownerUserId of ownerIds) {
        const profile = await getProfile(
            ownerUserId,
            input.profileId,
            input.actorUserId,
        );
        if (!profile) continue;
        if (profile.channel !== input.channel) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "The profile belongs to another channel",
                400,
            );
        }
        if (input.folder.scope === "org" && profile.scope !== "organization") {
            break;
        }
        return profile;
    }
    throw new AppError(
        ErrorCode.INVALID_INPUT,
        input.folder.scope === "org"
            ? "An Organization folder requires an Organization profile"
            : "The profile is not available to this folder's owner",
        400,
    );
}

export const GET = apiHandler<IdContext>(async (request, context) => {
    const { session, actor } = await requireApiSessionActor(request);
    const { id } = await (context as IdContext).params;
    const folder = await accessibleFolder(session.user.id, id);
    if (folder.parentId === null) throw rootRefused();
    return NextResponse.json(
        await responseBody(
            folder,
            session.user.id,
            await mayEditFolderDefault(folder, actor),
        ),
    );
});

export const PUT = apiHandler<IdContext>(async (request, context) => {
    const { session, actor } = await requireApiSessionActor(request);
    const { id } = await (context as IdContext).params;
    const folder = await accessibleFolder(session.user.id, id);
    if (folder.parentId === null) throw rootRefused();
    if (!(await mayEditFolderDefault(folder, actor))) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "You cannot change this folder's default profiles",
            403,
        );
    }
    const parsed = updateSchema.safeParse(
        await request.json().catch(() => null),
    );
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
            {
                issues: parsed.error.issues,
            },
        );
    }
    const { channel, profileId, manualOnly } = parsed.data;
    if (profileId) {
        await selectedProfile({
            folder,
            actorUserId: session.user.id,
            profileId,
            channel,
        });
        await db
            .insert(folderDefaultProfiles)
            .values({
                folderId: folder.id,
                channel,
                profileId,
                manualOnly: false,
            })
            .onConflictDoUpdate({
                target: [
                    folderDefaultProfiles.folderId,
                    folderDefaultProfiles.channel,
                ],
                set: { profileId, manualOnly: false },
            });
    } else if (manualOnly) {
        await db
            .insert(folderDefaultProfiles)
            .values({
                folderId: folder.id,
                channel,
                profileId: null,
                manualOnly: true,
            })
            .onConflictDoUpdate({
                target: [
                    folderDefaultProfiles.folderId,
                    folderDefaultProfiles.channel,
                ],
                set: { profileId: null, manualOnly: true },
            });
    } else {
        await db
            .delete(folderDefaultProfiles)
            .where(
                and(
                    eq(folderDefaultProfiles.folderId, folder.id),
                    eq(folderDefaultProfiles.channel, channel),
                ),
            );
    }
    return NextResponse.json(await responseBody(folder, session.user.id, true));
});
