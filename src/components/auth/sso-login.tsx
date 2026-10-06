"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { MetalButton } from "@/components/metal-button";
import { signIn } from "@/lib/auth-client";
import { SSO_ORG_ACCOUNT_ERROR, SSO_PROVIDER_ID } from "@/lib/sso/constants";

interface SsoLoginProps {
    /** The identity provider's name, as the operator configured it. */
    providerName: string;
    /** The `error` code the sign-in callback redirected back with, if any. */
    error?: string;
}

/**
 * Sign-in through the instance's OpenID Connect provider: the only way in
 * when single sign-on is configured.
 */
export function SsoLogin({ providerName, error }: SsoLoginProps) {
    const i18n = useExtracted();
    const [isLoading, setIsLoading] = useState(false);

    const errorMessage = (code: string): string => {
        switch (code) {
            case "account_not_linked":
                return i18n(
                    "A Riffado account with this email already exists, but your identity provider has not verified the address. Ask your administrator to verify it.",
                );
            case "unable_to_link_account":
            case SSO_ORG_ACCOUNT_ERROR:
                return i18n(
                    "This identity cannot sign in to Riffado. Ask your administrator.",
                );
            case "signup_disabled":
                return i18n(
                    "This Riffado instance does not accept new accounts. Ask your administrator.",
                );
            case "email_is_missing":
                return i18n(
                    "Your identity provider did not share an email address. Ask your administrator to release it to Riffado.",
                );
            case "access_denied":
                return i18n("Sign-in was cancelled at the identity provider.");
            default:
                return i18n("Sign-in failed. Please try again.");
        }
    };

    const handleClick = async () => {
        setIsLoading(true);
        try {
            const result = await signIn.oauth2({
                providerId: SSO_PROVIDER_ID,
                callbackURL: "/dashboard",
                errorCallbackURL: "/login",
            });
            if (result.error) {
                toast.error(i18n("Sign-in failed. Please try again."));
                setIsLoading(false);
            }
        } catch {
            toast.error(i18n("Sign-in failed. Please try again."));
            setIsLoading(false);
        }
    };

    return (
        <div className="space-y-4">
            {error ? (
                <p
                    role="alert"
                    className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                    {errorMessage(error)}
                </p>
            ) : null}
            <MetalButton
                type="button"
                className="w-full"
                variant="cyan"
                disabled={isLoading}
                onClick={handleClick}
            >
                {isLoading
                    ? i18n("Redirecting...")
                    : i18n("Sign in with {provider}", {
                          provider: providerName,
                      })}
            </MetalButton>
        </div>
    );
}
