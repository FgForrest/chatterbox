import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { logSessionDeleted } from "./auth/session-log";
import { runInAuthRequest } from "./authz/login-grant";
import { sessionAccess } from "./authz/session-access";
import { env } from "./env";
import { closeCycleForUser } from "./hosted/billing/cycle-close";
import { localeFromAcceptLanguage, normalizeLocale } from "./i18n/config";
import { isIdpAuthorization } from "./identity/factory";
import {
    sendEmailChangeConfirm,
    sendPasswordResetEmail,
    sendVerifyEmail,
} from "./notifications/email";
import { isSmtpConfigured } from "./smtp";
import {
    afterSsoSession,
    guardSsoSession,
    mapSsoProfile,
    prepareSsoAccount,
    SupersededSignInError,
    verifySsoLogin,
} from "./sso/auth-hooks";
import {
    isSsoEnabled,
    PASSWORD_AUTH_PATHS,
    PROVIDER_TOKEN_PATHS,
    ssoDiscoveryUrl,
} from "./sso/config";
import { SSO_PROVIDER_ID, SSO_UNAVAILABLE_ERROR } from "./sso/constants";
import { boundedSsoProvider, withSsoDeadline } from "./sso/discovery";

const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Email verification is enforced only on the hosted instance (and only
 * when SMTP is actually configured there -- no delivery channel for the
 * link otherwise). Self-host instances never enforce verification, even
 * when they configure SMTP for notification emails: `IS_HOSTED` is the
 * rollout boundary from `scripts/billing-backfill.ts`, which grandfathers
 * every pre-launch row to `emailVerified=true` -- that's a one-shot ops
 * script run once against the hosted DB at launch, not something
 * self-host operators ever run. Gating on `isSmtpConfigured()` alone
 * would flip verification on for any self-host deployment that has SMTP
 * configured and immediately lock out its existing unverified accounts.
 */
const verificationActive = env.IS_HOSTED && isSmtpConfigured();

function authEmailLocale(user: object, request?: Request) {
    const configuredLocale =
        "uiLocale" in user && typeof user.uiLocale === "string"
            ? normalizeLocale(user.uiLocale)
            : null;
    return (
        configuredLocale ??
        localeFromAcceptLanguage(
            request?.headers.get("accept-language") ?? null,
        )
    );
}

/**
 * Public alias for `verificationActive`, for callers outside this module
 * (e.g. the register page/form) that need to know whether sign-up leaves
 * the user unauthenticated pending email verification. Single source of
 * truth -- don't re-derive the `IS_HOSTED && isSmtpConfigured()` condition
 * elsewhere.
 */
export const emailVerificationRequired = verificationActive;

/**
 * With single sign-on the identity provider is the only way in: passwords,
 * sign-up and local email changes are off, and an SSO login attaches to an
 * existing account only when the provider vouches for the email
 * (`email_verified`). Riffado's own `emailVerified` is not required, since
 * self-host never verifies addresses.
 */
const ssoEnabled = isSsoEnabled();

const defaultDiscoveryTiming = {
    discoveryTimeoutMs: 10_000,
    candidateTimeoutMs: 12_000,
    retryIntervalMs: 30_000,
};
let discoveryTiming = { ...defaultDiscoveryTiming };

function ssoPlugins(includeProvider: boolean) {
    const issuer = env.OIDC_ISSUER_URL;
    const clientId = env.OIDC_CLIENT_ID;
    const clientSecret = env.OIDC_CLIENT_SECRET;
    if (
        !includeProvider ||
        !ssoEnabled ||
        !issuer ||
        !clientId ||
        !clientSecret
    )
        return [];
    return [
        boundedSsoProvider(
            {
                providerId: SSO_PROVIDER_ID,
                discoveryUrl: ssoDiscoveryUrl(issuer),
                clientId,
                clientSecret,
                scopes: env.OIDC_SCOPES,
                pkce: true,
                accountSubject: ({ profile }) => profile.sub ?? "",
                requireIdTokenVerification: true,
                redirectURI: new URL(
                    `/api/auth/oauth2/callback/${SSO_PROVIDER_ID}`,
                    env.APP_URL,
                ).href,
                disableProviderLogout: true,
                // A closed instance stays closed under single sign-on:
                // only existing accounts sign in.
                disableSignUp: env.DISABLE_REGISTRATION,
                overrideUserInfo: true,
                mapProfileToUser: mapSsoProfile,
                // With identity-provider authorization the profile and
                // the capabilities come from verified tokens only.
                ...(isIdpAuthorization()
                    ? { getUserInfo: verifySsoLogin }
                    : {}),
            },
            discoveryTiming.discoveryTimeoutMs,
        ),
    ];
}

function createAuthInstance(includeProvider: boolean) {
    return betterAuth({
        database: drizzleAdapter(db, {
            provider: "pg",
            schema,
            usePlural: true,
        }),
        ...(ssoEnabled
            ? {
                  disabledPaths: [
                      ...PASSWORD_AUTH_PATHS,
                      ...PROVIDER_TOKEN_PATHS,
                  ],
                  account: {
                      additionalFields: {
                          issuer: {
                              type: "string",
                              required: false,
                              input: false,
                          },
                      },
                      accountLinking: {
                          enabled: true,
                          requireLocalEmailVerified: false,
                      },
                      updateAccountOnSignIn: false,
                  },
                  session: {
                      expiresIn: env.OIDC_SESSION_MAX_AGE,
                      disableSessionRefresh: true,
                  },
                  onAPIError: { errorURL: `${env.APP_URL}/login` },
              }
            : {}),
        plugins: ssoPlugins(includeProvider),
        hooks: {
            before: createAuthMiddleware(async (ctx) => {
                if (
                    ctx.path === "/sign-in/social" &&
                    ctx.body?.provider === SSO_PROVIDER_ID &&
                    "idToken" in ctx.body
                ) {
                    throw new APIError("FORBIDDEN", {
                        code: "SSO_ID_TOKEN_SIGN_IN_DISABLED",
                        message:
                            "Single sign-on requires the authorization code flow",
                    });
                }
                if (
                    ssoEnabled &&
                    ctx.path === "/sign-in/social" &&
                    ctx.body?.provider === SSO_PROVIDER_ID &&
                    !ctx.context.socialProviders.some(
                        (provider) => provider.id === SSO_PROVIDER_ID,
                    )
                ) {
                    throw new APIError("SERVICE_UNAVAILABLE", {
                        code: SSO_UNAVAILABLE_ERROR,
                        message: "Single sign-on is temporarily unavailable",
                    });
                }
                if (
                    isIdpAuthorization() &&
                    ctx.path === "/sign-in/social" &&
                    ctx.body?.provider === SSO_PROVIDER_ID &&
                    ctx.body?.additionalData?.reauthenticate === true
                ) {
                    return {
                        context: {
                            body: {
                                ...ctx.body,
                                additionalParams: {
                                    ...ctx.body.additionalParams,
                                    max_age: "0",
                                    prompt: "login",
                                },
                            },
                        },
                    };
                }
            }),
        },
        emailAndPassword: {
            enabled: !ssoEnabled,
            requireEmailVerification: verificationActive,
            disableSignUp: env.DISABLE_REGISTRATION,
            sendResetPassword: async ({ user, url }, request) => {
                const locale = authEmailLocale(user, request);
                await sendPasswordResetEmail(user.email, url, locale);
            },
            resetPasswordTokenExpiresIn: 60 * 60,
            revokeSessionsOnPasswordReset: true,
        },
        emailVerification: {
            sendVerificationEmail: async ({ user, url }, request) => {
                if (!verificationActive) return;
                await sendVerifyEmail({
                    email: user.email,
                    verificationUrl: url,
                    expiresInSeconds: EMAIL_VERIFICATION_TTL_SECONDS,
                    locale: authEmailLocale(user, request),
                });
            },
            sendOnSignUp: verificationActive,
            autoSignInAfterVerification: true,
            expiresIn: EMAIL_VERIFICATION_TTL_SECONDS,
        },
        user: {
            additionalFields: {
                uiLocale: {
                    type: "string",
                    required: false,
                    input: false,
                },
            },
            changeEmail: {
                enabled: !ssoEnabled,
                sendChangeEmailConfirmation: async (
                    { user, newEmail, url },
                    request,
                ) => {
                    if (!verificationActive) return;
                    await sendEmailChangeConfirm({
                        sendTo: user.email,
                        newEmail,
                        confirmUrl: url,
                        expiresInSeconds: EMAIL_VERIFICATION_TTL_SECONDS,
                        locale: authEmailLocale(user, request),
                    });
                },
            },
        },
        /**
         * On hosted instances with billing enabled, every new user starts on
         * a 14-day Pro trial (`plan='hosted_pro'`, `planTransitionUntil = now
         * + BILLING_TRIAL_DAYS`). After the trial elapses without payment,
         * the billing worker demotes them and starts the deletion grace
         * countdown.
         *
         * Self-host (`!IS_HOSTED`) leaves `plan` NULL. The hosted-billing
         * code paths are gated on a non-null plan everywhere.
         */
        databaseHooks: {
            ...(ssoEnabled
                ? {
                      account: { create: { before: prepareSsoAccount } },
                      session: {
                          delete: {
                              after: async (session, context) => {
                                  logSessionDeleted(session, context?.path);
                              },
                          },
                          create: {
                              before: guardSsoSession,
                              after: afterSsoSession,
                          },
                      },
                  }
                : {}),
            user: {
                create: {
                    // The image column satisfies Better Auth's schema; profile images stay unrecorded.
                    before: async () => ({ data: { image: null } }),
                    after: async (user) => {
                        if (!env.IS_HOSTED || !env.BILLING_ENABLED) return;
                        const trialMs =
                            env.BILLING_TRIAL_DAYS * 24 * 60 * 60 * 1000;
                        await db
                            .update(schema.users)
                            .set({
                                plan: "hosted_pro",
                                planTransitionUntil: new Date(
                                    Date.now() + trialMs,
                                ),
                                updatedAt: new Date(),
                            })
                            .where(eq(schema.users.id, user.id));
                        // Grant the Pro Mynah budget synchronously instead of
                        // waiting for the billing worker's next tick (up to
                        // TICK_MS after signup) -- otherwise a user who tries
                        // hosted transcription immediately after signing up hits
                        // the schema default of 0 remaining seconds.
                        await closeCycleForUser(user.id);
                    },
                },
                update: {
                    before: async () => ({ data: { image: null } }),
                },
            },
        },
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.APP_URL,
    });
}

type AuthInstance = ReturnType<typeof createAuthInstance>;
let betterAuthInstance: AuthInstance | undefined;
let fallbackReady: Promise<unknown> | undefined;
let initialProviderBuild: Promise<void> | undefined;
let ssoRetry: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

function startProviderBuild(): Promise<void> {
    if (ssoRetry) return ssoRetry;
    const startedAt = Date.now();
    const buildGeneration = generation;
    ssoRetry = (async () => {
        try {
            const candidate = createAuthInstance(true);
            const context = await withSsoDeadline(
                candidate.$context,
                discoveryTiming.candidateTimeoutMs,
            );
            if (
                generation === buildGeneration &&
                context.socialProviders.some(
                    (provider) => provider.id === SSO_PROVIDER_ID,
                )
            ) {
                betterAuthInstance = candidate;
                return;
            }
        } catch {
            console.warn("SSO provider initialization unavailable");
        }
        if (generation !== buildGeneration) return;
        retryTimer = setTimeout(
            () => {
                void startProviderBuild();
            },
            Math.max(
                0,
                startedAt + discoveryTiming.retryIntervalMs - Date.now(),
            ),
        );
        retryTimer.unref?.();
    })().finally(() => {
        if (generation === buildGeneration) ssoRetry = null;
    });
    return ssoRetry;
}

function initializeAuth() {
    if (betterAuthInstance) return;
    betterAuthInstance = createAuthInstance(false);
    fallbackReady = betterAuthInstance.$context;
    if (ssoEnabled) initialProviderBuild = startProviderBuild();
}

function currentInstance(): AuthInstance {
    initializeAuth();
    if (!betterAuthInstance) throw new Error("Auth instance not initialized");
    return betterAuthInstance;
}

async function availableAuthInstance(
    needsProvider = false,
): Promise<AuthInstance> {
    initializeAuth();
    await fallbackReady;
    if (needsProvider) await initialProviderBuild;
    return currentInstance();
}

/** Reset lazy authentication and inject discovery deadlines in isolated tests. */
export function resetAuthDiscoveryForTests(
    timing: Partial<typeof defaultDiscoveryTiming> = {},
): void {
    if (process.env.NODE_ENV !== "test")
        throw new Error("Test-only auth reset");
    generation++;
    clearTimeout(retryTimer);
    betterAuthInstance = undefined;
    fallbackReady = undefined;
    initialProviderBuild = undefined;
    ssoRetry = null;
    routedApi = undefined;
    discoveryTiming = { ...defaultDiscoveryTiming, ...timing };
}

/**
 * `/get-session` for the browser: a session whose access no longer holds
 * (identity-provider authorization) reads as signed out.
 */
async function guardedGetSession(response: Response): Promise<Response> {
    if (!response.ok) return response;
    const body = (await response
        .clone()
        .json()
        .catch(() => null)) as {
        session?: { id?: unknown; userId?: unknown };
    } | null;
    const id = body?.session?.id;
    const userId = body?.session?.userId;
    if (typeof id !== "string" || typeof userId !== "string") return response;
    const access = await sessionAccess({ id, userId });
    if (access.ok) return response;
    if (access.reason === "unavailable") {
        return Response.json(
            { error: "Access could not be verified" },
            {
                status: 503,
                headers: { "Retry-After": "30", "Cache-Control": "no-store" },
            },
        );
    }
    return Response.json(null, { headers: response.headers });
}

const PROVIDER_PATHS: ReadonlySet<string> = new Set([
    "/api/auth/sign-in/social",
    `/api/auth/callback/${SSO_PROVIDER_ID}`,
]);

/**
 * Every auth request runs in its own scope, where a verified sign-in keeps
 * its grant for the session it creates.
 */
async function handler(request: Request): Promise<Response> {
    return runInAuthRequest(async () => {
        let response: Response;
        try {
            const url = new URL(request.url);
            if (
                ssoEnabled &&
                url.pathname === `/api/auth/oauth2/callback/${SSO_PROVIDER_ID}`
            ) {
                // Keep the redirect URI already registered at existing providers.
                url.pathname = `/api/auth/callback/${SSO_PROVIDER_ID}`;
                request = new Request(url, request);
            }
            const instance = await availableAuthInstance(
                PROVIDER_PATHS.has(url.pathname.replace(/\/+$/, "")),
            );
            response = await instance.handler(request);
        } catch (error) {
            if (error instanceof SupersededSignInError) {
                return Response.redirect(
                    `${env.APP_URL}/login?error=${SSO_UNAVAILABLE_ERROR}`,
                    302,
                );
            }
            throw error;
        }
        if (
            isIdpAuthorization() &&
            new URL(request.url).pathname.endsWith("/get-session")
        ) {
            return guardedGetSession(response);
        }
        return response;
    });
}

type AuthApi = AuthInstance["api"];

const PROVIDER_ENDPOINTS: ReadonlySet<string> = new Set([
    "signInSocial",
    "callbackOAuth",
]);

/**
 * `auth.api` with every endpoint routed to the instance serving at call
 * time. Built once: both instances expose the same endpoints, and each
 * wrapper keeps its endpoint's own properties (`path`, `options`).
 */
function buildRoutedApi(): AuthApi {
    const routed: Record<string, unknown> = {};
    for (const [name, endpoint] of Object.entries(currentInstance().api)) {
        routed[name] =
            typeof endpoint === "function"
                ? Object.assign(async (...args: unknown[]) => {
                      const instance = await availableAuthInstance(
                          PROVIDER_ENDPOINTS.has(name),
                      );
                      const current = instance.api[name as keyof AuthApi] as (
                          ...callArgs: unknown[]
                      ) => unknown;
                      return current.apply(instance.api, args);
                  }, endpoint)
                : endpoint;
    }
    return routed as AuthApi;
}

let routedApi: AuthApi | undefined;

/**
 * The better-auth instance serving now, created on first use: `handler`
 * and `fetch` route each request, `api` each call, and `$context` waits
 * (bounded) for the identity provider.
 */
export const auth = {
    handler,
    fetch: handler,
    get api(): AuthApi {
        routedApi ??= buildRoutedApi();
        return routedApi;
    },
    get options(): AuthInstance["options"] {
        return currentInstance().options;
    },
    get $context(): AuthInstance["$context"] {
        return availableAuthInstance(true).then(
            (instance) => instance.$context,
        );
    },
    get $ERROR_CODES(): AuthInstance["$ERROR_CODES"] {
        return currentInstance().$ERROR_CODES;
    },
} as AuthInstance;

export type Session = typeof auth.$Infer.Session;
