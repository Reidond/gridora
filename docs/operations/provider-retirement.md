# Provider retirement runbook

1. Stop new placement on the node.
2. List every active server and paid resource.
3. Apply the required backup policy.
4. Drain or stop each server.
5. Revoke node, Tunnel, and game secrets.
6. Delete Gridora data when the provider supports secure wipe.
7. Request provider retirement.
8. Record the provider request ID.
9. Record the effective billing end date.
10. Continue reconciliation until the provider confirms the final state.

Contabo retirement does not mean immediate billing termination. The UI and audit
record must show the contract state. Do not claim deletion before confirmation.
