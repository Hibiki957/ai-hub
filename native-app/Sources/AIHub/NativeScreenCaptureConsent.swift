/// Shared by all native tabs for the lifetime of one Hub process. Checking an
/// existing grant is harmless; an unconfirmed request can trigger macOS UI and
/// must not be repeated by another tab or by repeated Retry clicks.
struct NativeScreenCaptureConsent {
    private(set) var attemptedUnconfirmedAccess = false
    private(set) var deniedInThisProcess = false

    mutating func allowAttempt(preflightAllowed: Bool) -> Bool {
        guard !deniedInThisProcess else { return false }
        if preflightAllowed { return true }
        guard !attemptedUnconfirmedAccess else { return false }
        attemptedUnconfirmedAccess = true
        return true
    }

    mutating func recordDenial() {
        attemptedUnconfirmedAccess = true
        deniedInThisProcess = true
    }
}
