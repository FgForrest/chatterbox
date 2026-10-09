import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import {
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
    GOOGLE_DRIVE_FILE_SCOPE,
    getGoogleOAuthConfig,
    isGoogleIntegrationAvailable,
} from "@/lib/integrations/google/config";
import {
    disconnectGoogle,
    getGoogleConnectionStatus,
} from "@/lib/integrations/google/connection";
import { GOOGLE_MEET_READ_SCOPE } from "@/lib/integrations/google/meet-consent";

export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const available = isGoogleIntegrationAvailable();
    const calendarAvailable = getGoogleOAuthConfig() !== null;
    const connection =
        available || calendarAvailable
            ? await getGoogleConnectionStatus(session.user.id)
            : null;
    return NextResponse.json({
        available,
        calendarAvailable,
        meetAvailable: calendarAvailable,
        connection: connection
            ? {
                  email: connection.email,
                  hostedDomain: connection.hostedDomain,
                  status: connection.status,
                  calendarGranted: connection.scopes.includes(
                      GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
                  ),
                  meetGranted: connection.scopes.includes(
                      GOOGLE_MEET_READ_SCOPE,
                  ),
                  driveGranted: connection.scopes.includes(
                      GOOGLE_DRIVE_FILE_SCOPE,
                  ),
              }
            : null,
    });
});

export const DELETE = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const disconnected = await disconnectGoogle(session.user.id);
    return NextResponse.json({ disconnected });
});
