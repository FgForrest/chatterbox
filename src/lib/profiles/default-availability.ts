/** Whether an unavailable account default is still reached after folder resolution. */
export function accountDefaultUnavailableApplies(
    accountDefaultUnavailable: boolean | undefined,
    higherPrecedenceResolved: boolean,
): boolean {
    return accountDefaultUnavailable === true && !higherPrecedenceResolved;
}
