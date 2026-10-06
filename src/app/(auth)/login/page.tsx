import { getExtracted } from "next-intl/server";
import {
    HostedAuthChrome,
    SelfHostAuthChrome,
} from "@/components/auth/auth-chrome";
import { LoginForm } from "@/components/auth/login-form";
import { SsoLogin } from "@/components/auth/sso-login";
import { redirectIfAuthenticated } from "@/lib/auth-server";
import { env } from "@/lib/env";
import { isSmtpConfigured } from "@/lib/smtp";
import { isSsoEnabled } from "@/lib/sso/config";

interface LoginPageProps {
    searchParams: Promise<{ error?: string | string[] }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
    const i18n = await getExtracted();
    await redirectIfAuthenticated();

    if (isSsoEnabled()) {
        const { error } = await searchParams;
        return (
            <SelfHostAuthChrome
                title={i18n("Sign in")}
                subtitle={i18n("Sign in to your Riffado instance.")}
            >
                <SsoLogin
                    providerName={env.OIDC_PROVIDER_NAME}
                    error={Array.isArray(error) ? error[0] : error}
                />
            </SelfHostAuthChrome>
        );
    }

    const formProps = {
        registrationEnabled: !env.DISABLE_REGISTRATION,
        smtpConfigured: isSmtpConfigured(),
    };

    if (env.IS_HOSTED) {
        return (
            <HostedAuthChrome
                title={i18n("Sign in")}
                subtitle={i18n("Welcome back to Riffado.")}
            >
                <LoginForm {...formProps} />
            </HostedAuthChrome>
        );
    }

    return (
        <SelfHostAuthChrome
            title={i18n("Sign in")}
            subtitle={i18n("Sign in to your Riffado instance.")}
        >
            <LoginForm {...formProps} />
        </SelfHostAuthChrome>
    );
}
