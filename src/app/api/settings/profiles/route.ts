import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { getOrgUserId } from "@/lib/org/config";
import { mayEditProfile } from "@/lib/profiles/access";
import { validateProfileProviderPins } from "@/lib/profiles/providers";
import {
    defaultProfileSettings,
    type ProfileSettings,
} from "@/lib/profiles/settings";
import {
    createProfile,
    getDefaultProfileState,
    listActorProfiles,
    profileDeleteDisposition,
} from "@/lib/profiles/store";
import {
    ensureActorProfiles,
    parseSettings,
    profileChannelSchema,
    profileDetail,
    profileRouteActor,
    profileScopeSchema,
    profileSummary,
    validationError,
} from "./_shared";

const querySchema = z.object({
    channel: profileChannelSchema.optional(),
    scope: profileScopeSchema.optional(),
    q: z.string().max(200).optional(),
    archived: z.literal("true").optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const createSchema = z
    .object({
        name: z.string().trim().min(1).max(200),
        description: z.string().max(2000).nullable().optional(),
        channel: profileChannelSchema,
        scope: profileScopeSchema.default("personal"),
        settings: z.unknown().optional(),
    })
    .strict();

export const GET = apiHandler(async (request: Request) => {
    const routeActor = await profileRouteActor(request);
    await ensureActorProfiles(routeActor.userId);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
        channel: url.searchParams.get("channel") || undefined,
        scope: url.searchParams.get("scope") || undefined,
        q: url.searchParams.get("q") || undefined,
        archived: url.searchParams.get("archived") || undefined,
        page: url.searchParams.get("page") || undefined,
        pageSize: url.searchParams.get("pageSize") || undefined,
    });
    if (!parsed.success) throw validationError(parsed.error);
    const { page, pageSize, q, channel, scope, archived } = parsed.data;
    const result = await listActorProfiles({
        actor: routeActor.actor,
        search: q,
        channel,
        scope,
        archivedOnly: archived === "true",
        offset: (page - 1) * pageSize,
        limit: pageSize,
    });
    const orgUserId = await getOrgUserId();
    const [audioDefault, mailDefault, defaultOptions] = await Promise.all([
        getDefaultProfileState(routeActor.userId, "audio"),
        getDefaultProfileState(routeActor.userId, "mail"),
        listActorProfiles({
            actor: routeActor.actor,
            offset: 0,
            limit: 100,
        }),
    ]);
    const canCreateOrganization = orgUserId
        ? await mayEditProfile(routeActor.actor, {
              ownerUserId: orgUserId,
              scope: "organization",
          })
        : false;
    const states = { audio: audioDefault, mail: mailDefault };
    const profiles = await Promise.all(
        result.items.map(async (profile) => {
            const summary = await profileSummary(profile, routeActor.actor);
            const state = states[profile.channel];
            const deleteDisposition =
                profile.scope === "personal" && summary.canEdit
                    ? await profileDeleteDisposition(
                          routeActor.userId,
                          profile.id,
                      )
                    : null;
            return {
                ...summary,
                isYourDefault: state.effective?.id === profile.id,
                isOrganizationDefault:
                    state.organizationDefault?.id === profile.id,
                deleteDisposition,
            };
        }),
    );
    return NextResponse.json({
        profiles,
        defaults: {
            audio: {
                selected:
                    audioDefault.source === "organization" &&
                    !audioDefault.pointerId
                        ? "organization_default"
                        : (audioDefault.pointerId ??
                          audioDefault.effective?.id ??
                          null),
                organizationDefault: audioDefault.organizationDefault
                    ? {
                          id: audioDefault.organizationDefault.id,
                          name: audioDefault.organizationDefault.name,
                      }
                    : null,
                explicitUnavailable: audioDefault.explicitUnavailable,
            },
            mail: {
                selected:
                    mailDefault.source === "organization" &&
                    !mailDefault.pointerId
                        ? "organization_default"
                        : (mailDefault.pointerId ??
                          mailDefault.effective?.id ??
                          null),
                organizationDefault: mailDefault.organizationDefault
                    ? {
                          id: mailDefault.organizationDefault.id,
                          name: mailDefault.organizationDefault.name,
                      }
                    : null,
                explicitUnavailable: mailDefault.explicitUnavailable,
            },
            options: defaultOptions.items.map((profile) => ({
                id: profile.id,
                name: profile.name,
                channel: profile.channel,
                scope: profile.scope,
            })),
        },
        pagination: {
            page,
            pageSize,
            total: result.total,
            totalPages: Math.ceil(result.total / pageSize),
        },
        permissions: { canCreateOrganization },
    });
});

export const POST = apiHandler(async (request: Request) => {
    const routeActor = await profileRouteActor(request);
    await ensureActorProfiles(routeActor.userId);
    const parsed = createSchema.safeParse(
        await request.json().catch(() => null),
    );
    if (!parsed.success) throw validationError(parsed.error);
    const body = parsed.data;
    const ownerUserId =
        body.scope === "personal" ? routeActor.userId : await getOrgUserId();
    if (!ownerUserId) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Organization profiles are not available on this instance",
            404,
        );
    }
    if (
        !(await mayEditProfile(routeActor.actor, {
            ownerUserId,
            scope: body.scope,
        }))
    ) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "You cannot create a profile in this scope",
            403,
        );
    }
    const settings: ProfileSettings =
        body.settings === undefined
            ? defaultProfileSettings(body.channel)
            : parseSettings(body.channel, body.settings);
    await validateProfileProviderPins({
        actorUserId: routeActor.userId,
        profileOwnerUserId: ownerUserId,
        profileScope: body.scope,
        settings,
    });
    const profile = await createProfile({
        ownerUserId,
        actor: routeActor.actor,
        scope: body.scope,
        channel: body.channel,
        name: body.name,
        description: body.description,
        settings,
    });
    return NextResponse.json(
        { profile: await profileDetail(profile, routeActor.actor) },
        { status: 201 },
    );
});
