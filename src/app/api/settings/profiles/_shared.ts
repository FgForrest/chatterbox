import { type ZodError, z } from "zod";
import { MAIL_SUMMARY_PROMPT_PARTS } from "@/lib/ai/mail-summary-prompts";
import { SUMMARY_PROMPT_PARTS } from "@/lib/ai/summary-presets";
import { requireApiSessionActor } from "@/lib/auth-server";
import type { ActorContext } from "@/lib/authz/model";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    type AppLocale,
    localeFromAcceptLanguage,
    normalizeLocale,
} from "@/lib/i18n/config";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import { mayEditProfile } from "@/lib/profiles/access";
import { BUILTIN_PROMPTS_VERSION } from "@/lib/profiles/prompts";
import { resolveSelectedProfile } from "@/lib/profiles/resolve";
import { ensureProfiles } from "@/lib/profiles/seed";
import {
    audioProfileSettingsSchema,
    mailProfileSettingsSchema,
    type ProfileChannel,
    type ProfileSettings,
    profileChannelSchema,
} from "@/lib/profiles/settings";
import { getProfile, type ProfileRecord } from "@/lib/profiles/store";

export const profileScopeSchema = z.enum(["personal", "organization"]);

export interface ProfileRouteActor {
    actor: ActorContext;
    userId: string;
    locale: AppLocale;
}

export async function profileRouteActor(
    request: Request,
): Promise<ProfileRouteActor> {
    const { session, actor } = await requireApiSessionActor(request);
    return {
        actor,
        userId: session.user.id,
        locale:
            normalizeLocale(session.user.uiLocale) ??
            localeFromAcceptLanguage(request.headers.get("accept-language")),
    };
}

export async function ensureActorProfiles(userId: string): Promise<void> {
    await ensureProfiles(userId);
    const orgUserId = await getOrgUserId();
    if (isOrgScopeEnabled() && orgUserId && orgUserId !== userId) {
        await ensureProfiles(orgUserId);
    }
}

export function validationError(
    error: ZodError,
    prefix: PropertyKey[] = [],
): AppError {
    return new AppError(ErrorCode.INVALID_INPUT, "Invalid request body", 400, {
        issues: error.issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            path: [...prefix, ...issue.path],
        })),
    });
}

export function parseSettings(
    channel: ProfileChannel,
    value: unknown,
): ProfileSettings {
    const parsed =
        channel === "audio"
            ? audioProfileSettingsSchema.safeParse(value)
            : mailProfileSettingsSchema.safeParse(value);
    if (!parsed.success) throw validationError(parsed.error, ["settings"]);
    return parsed.data;
}

export async function availableProfile(id: string, actor: ProfileRouteActor) {
    const resolved = await resolveSelectedProfile({
        profileId: id,
        actorUserId: actor.userId,
    });
    if (!resolved) {
        throw new AppError(ErrorCode.NOT_FOUND, "Profile not found", 404);
    }
    return resolved;
}

export async function editableProfile(id: string, actor: ProfileRouteActor) {
    const resolved = await availableProfile(id, actor);
    if (!(await mayEditProfile(actor.actor, resolved.profile))) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "You may use this profile but cannot edit it",
            403,
        );
    }
    return resolved;
}

/** Resolve an archived profile only when the request actor may edit it. */
export async function editableArchivedProfile(
    id: string,
    actor: ProfileRouteActor,
) {
    const orgUserId = await getOrgUserId();
    const ownerIds = [actor.userId, ...(orgUserId ? [orgUserId] : [])];
    for (const ownerUserId of new Set(ownerIds)) {
        const profile = await getProfile(ownerUserId, id, actor.userId, {
            includeArchived: true,
        });
        if (!profile?.archivedAt) continue;
        if (!(await mayEditProfile(actor.actor, profile))) {
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "You may use this profile but cannot edit it",
                403,
            );
        }
        return { profile };
    }
    throw new AppError(ErrorCode.NOT_FOUND, "Profile not found", 404);
}

export async function profileSummary(
    profile: ProfileRecord,
    actor: ActorContext,
) {
    return {
        id: profile.id,
        name: profile.name,
        description: profile.description,
        channel: profile.channel,
        scope: profile.scope,
        isDefault: profile.isDefault,
        version: profile.version,
        canEdit: await mayEditProfile(actor, profile),
        archivedAt: profile.archivedAt,
        updatedAt: profile.updatedAt,
    };
}

export async function profileDetail(
    profile: ProfileRecord,
    actor: ActorContext,
) {
    return {
        ...(await profileSummary(profile, actor)),
        settings: profile.settings,
    };
}

export function builtinPromptTexts(profile: ProfileRecord) {
    const preset = profile.settings.steps.summary.preset;
    const parts =
        preset === "mail"
            ? MAIL_SUMMARY_PROMPT_PARTS
            : SUMMARY_PROMPT_PARTS[preset];
    return {
        builtinPromptsVersion: BUILTIN_PROMPTS_VERSION,
        builtins: {
            focus: parts.focus,
            outputFormat: parts.outputFormat,
        },
    };
}

export { profileChannelSchema };
