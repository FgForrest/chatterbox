import { cache } from "react";
import type { AppChromeConfig } from "@/components/app-chrome-provider";
import { accessManagementAvailable } from "@/lib/access/service";
import { getSessionActor, requireAuth } from "@/lib/auth-server";
import { env } from "@/lib/env";
import { isAdminEmail } from "@/lib/hosted/admin/guard";
import {
    loadOnboardingCapabilities,
    loadOnboardingReadiness,
} from "@/lib/onboarding/readiness";
import { getOrgUserId, isOrgAccount } from "@/lib/org/config";
import { initialSettingsFromRow } from "@/lib/settings/initial-settings";
import { getPlaudConnection } from "@/lib/settings/plaud-connection";
import { getUserSettings } from "@/lib/settings/user-settings";

/** Server-owned identity, capabilities and preferences for the shared app dialogs. */
export const appChromeConfig = cache(async (): Promise<AppChromeConfig> => {
    const session = await requireAuth();
    const [settings, actor, organization, organizationId] = await Promise.all([
        getUserSettings(session.user.id),
        getSessionActor(),
        isOrgAccount(session.user.id),
        getOrgUserId(),
    ]);
    const onboardingCapabilities = await loadOnboardingCapabilities(
        session.user.id,
        {
            id: organizationId,
            isAccount: organization,
        },
    );
    const onboardingReadiness = settings?.onboardingCompleted
        ? undefined
        : await loadOnboardingReadiness(
              session.user.id,
              onboardingCapabilities,
              {
                  plaudConnection: await getPlaudConnection(session.user.id),
              },
          );
    return {
        initialSettings: initialSettingsFromRow(settings),
        isAdmin: isAdminEmail(session.user.email),
        userEmail: session.user.email ?? null,
        isHosted: env.IS_HOSTED,
        mailEnabled: onboardingCapabilities.mailAvailable,
        isOrgAccount: organization,
        accessManagement: accessManagementAvailable(actor),
        onboardingCapabilities,
        onboardingReadiness,
    };
});
