import { eq } from "drizzle-orm";
import { cache } from "react";
import type { AppChromeConfig } from "@/components/app-chrome-provider";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { accessManagementAvailable } from "@/lib/access/service";
import { getSessionActor, requireAuth } from "@/lib/auth-server";
import { env } from "@/lib/env";
import { isAdminEmail } from "@/lib/hosted/admin/guard";
import { getGoogleOAuthConfig } from "@/lib/integrations/google/config";
import { isMailEnabled } from "@/lib/mail/config";
import { isMcpEnabled } from "@/lib/mcp/config";
import { mcpResourceUrl } from "@/lib/mcp/metadata";
import { isOrgAccount } from "@/lib/org/config";
import { RECORDER_EXTENSION_STORE_URL } from "@/lib/recorder-extension/extension-id";
import { initialSettingsFromRow } from "@/lib/settings/initial-settings";

/** Server-owned identity, capabilities and preferences for the shared app dialogs. */
export const appChromeConfig = cache(async (): Promise<AppChromeConfig> => {
    const session = await requireAuth();
    const [rows, actor, organization] = await Promise.all([
        db
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, session.user.id))
            .limit(1),
        getSessionActor(),
        isOrgAccount(session.user.id),
    ]);
    const mailEnabled = isMailEnabled() && !organization;
    return {
        initialSettings: initialSettingsFromRow(rows[0]),
        isAdmin: isAdminEmail(session.user.email),
        userEmail: session.user.email ?? null,
        isHosted: env.IS_HOSTED,
        mailEnabled,
        accessManagement: accessManagementAvailable(actor),
        onboardingCapabilities: {
            googleConfigured: getGoogleOAuthConfig() !== null,
            mailAvailable: mailEnabled,
            mcpConnectorUrl: isMcpEnabled() ? mcpResourceUrl() : null,
            recorderStoreUrl: RECORDER_EXTENSION_STORE_URL,
        },
    };
});
