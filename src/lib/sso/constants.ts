/** better-auth provider id; part of the callback URL registered at the IdP. */
export const SSO_PROVIDER_ID = "oidc";

/** Error code the login page explains: the organization account has no SSO login. */
export const SSO_ORG_ACCOUNT_ERROR = "ORG_ACCOUNT_SSO";

/** The identity provider grants this person no `use` of Chatterbox. */
export const SSO_ACCESS_DENIED_ERROR = "SSO_ACCESS_DENIED";

/** A token of the sign-in did not verify. */
export const SSO_TOKEN_INVALID_ERROR = "SSO_TOKEN_INVALID";

/** The identity provider could not be asked to verify the sign-in. */
export const SSO_UNAVAILABLE_ERROR = "SSO_UNAVAILABLE";

/** The account is bound to another issuer. */
export const SSO_ISSUER_MISMATCH_ERROR = "SSO_ISSUER_MISMATCH";

/** The identity provider ended the sign-in, or the person lost access. */
export const SSO_SESSION_ENDED_ERROR = "SSO_SESSION_ENDED";
