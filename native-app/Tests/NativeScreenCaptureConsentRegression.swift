@main
struct NativeScreenCaptureConsentRegression {
    static func main() {
        var sharedSession = NativeScreenCaptureConsent()
        precondition(sharedSession.allowAttempt(preflightAllowed: false), "First explicit attempt may reach macOS")
        for _ in 0..<100 {
            precondition(!sharedSession.allowAttempt(preflightAllowed: false), "Other tabs and repeat clicks must not re-prompt")
        }
        precondition(sharedSession.allowAttempt(preflightAllowed: true), "A newly effective grant may be checked without restarting")
        precondition(!sharedSession.allowAttempt(preflightAllowed: false), "Losing the grant does not reset the prompt guard")

        var existingGrant = NativeScreenCaptureConsent()
        for _ in 0..<10 {
            precondition(existingGrant.allowAttempt(preflightAllowed: true))
        }
        precondition(!existingGrant.attemptedUnconfirmedAccess, "Read-only preflight checks do not consume the explicit attempt")
        existingGrant.recordDenial()
        precondition(!existingGrant.allowAttempt(preflightAllowed: false), "An actual SCK denial prevents repeated requests")
        precondition(!existingGrant.allowAttempt(preflightAllowed: true), "After a real denial, a stale positive preflight must not prompt again")

        var nextProcess = NativeScreenCaptureConsent()
        precondition(nextProcess.allowAttempt(preflightAllowed: false), "A new process can perform its own explicit attempt")
        print("Screen capture consent: first attempt, repeated clicks/tabs, newly effective grant, revocation, denial, and new session checks passed.")
    }
}
