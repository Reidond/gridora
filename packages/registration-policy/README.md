# Registration policy

This package applies the server-side account registration policy.

## Policy choice

The product contract calls the third mode “disabled sign-up.” This package names that mode
`closed`. The mode disables public identity creation. It does not disable invitation onboarding.
The product contract separately allows a local identity upsert through a valid invitation.
Therefore, `closed` permits a valid, unconsumed, unexpired invitation that is bound to the
authenticated external identity.

## Integration rules

1. Validate the Cloudflare Access assertion.
2. Verify the signed, short-lived authentication intent on the server.
3. Look up the local identity.
4. For invitation completion, verify the invitation token hash on the server.
5. Pass only the verified invitation binding to `RegistrationPolicyService`.
6. Create an identity only when the result is `allow-create`.
7. Keep identity creation and invitation consumption atomic and idempotent.
8. Map both invalid invitations and policy denials to the same public response.
9. Do not derive intent, registration mode, or invitation validity from a query parameter.

The audit port must deduplicate records by `decisionId`. A replay produces the same policy result
and the same logical audit decision. Invitation consumption remains the responsibility of the
atomic onboarding unit of work.
