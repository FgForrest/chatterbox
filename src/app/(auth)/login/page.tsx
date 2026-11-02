import { redirect } from "next/navigation";
import { getExtracted, getLocale } from "next-intl/server";
import {
    HostedAuthChrome,
    SelfHostAuthChrome,
} from "@/components/auth/auth-chrome";
import { LoginForm } from "@/components/auth/login-form";
import { SsoLogin } from "@/components/auth/sso-login";
import { loginReturnPath } from "@/lib/auth/return-path";
import { getSession } from "@/lib/auth-server";
import { deploymentProductName } from "@/lib/deployment-brand";
import { env } from "@/lib/env";
import { isSmtpConfigured } from "@/lib/smtp";
import { isSsoEnabled } from "@/lib/sso/config";

interface LoginPageProps {
    searchParams: Promise<{
        error?: string | string[];
        returnTo?: string | string[];
    }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
    const i18n = await getExtracted();
    const locale = await getLocale();
    const name = deploymentProductName(locale);
    const instanceSubtitle = i18n("Sign in to your {name} instance.", {
        name,
    });
    const { error, returnTo } = await searchParams;
    const destination = loginReturnPath(
        Array.isArray(returnTo) ? returnTo[0] : returnTo,
    );
    if ((await getSession())?.user) redirect(destination);

    if (isSsoEnabled()) {
        return (
            <SelfHostAuthChrome
                title={i18n("Sign in")}
                subtitle={instanceSubtitle}
            >
                <SsoLogin
                    providerName={env.OIDC_PROVIDER_NAME}
                    error={Array.isArray(error) ? error[0] : error}
                    returnTo={destination}
                />
            </SelfHostAuthChrome>
        );
    }

    const formProps = {
        returnTo: destination,
        registrationEnabled: !env.DISABLE_REGISTRATION,
        smtpConfigured: isSmtpConfigured(),
    };

    if (env.IS_HOSTED) {
        return (
            <HostedAuthChrome
                title={i18n("Sign in")}
                subtitle={i18n("Welcome back to {name}.", { name })}
            >
                <LoginForm {...formProps} />
            </HostedAuthChrome>
        );
    }

    return (
        <SelfHostAuthChrome title={i18n("Sign in")} subtitle={instanceSubtitle}>
            <LoginForm {...formProps} />
        </SelfHostAuthChrome>
    );
}
