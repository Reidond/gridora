# Security incident runbook

1. Record the incident time and organization scope.
2. Preserve audit, provider, Worker, agent, and registry evidence.
3. Stop new placement for the affected scope.
4. Revoke the smallest affected credential set.
5. Rotate a parent credential when its child scope is uncertain.
6. Quarantine affected nodes from management traffic.
7. Keep game traffic active only when it is safe.
8. Find every external resource through provider reconciliation.
9. Restore service from a signed known-good version.
10. Notify affected operators through the approved channel.
11. Record every forced action and reason.
12. Update the threat model and a test after the review.

Never delete an unknown provider instance during triage. Mark it as an orphan.
