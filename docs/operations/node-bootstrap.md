# Node bootstrap runbook

1. Select one promoted image for the provider region.
2. Create one node operation ID.
3. Create one short-lived registration token.
4. Bind the token to the organization, node, and provider instance.
5. Create one Tunnel connector token.
6. Render `infra/images/cloud-init/node-bootstrap.yaml.tmpl` with a validated,
   base64-encoded agent configuration.
7. Send the user data through the provider API.
8. Wait for the outbound Tunnel connection.
9. Verify the provider instance identity.
10. Exchange the registration token for a node credential.
11. Store the node credential in the agent state directory with mode `0600`.
12. Atomically remove `/var/lib/gridora/bootstrap/registration-token`.
13. Revoke the registration token at the control plane.
14. Keep the Tunnel token in `/etc/gridora/cloudflared-token` with mode `0600`.
15. Rotate the Tunnel token through the node-credential workflow.
16. Reconcile the firewall and agent capability report.
17. Reboot the node and verify that the agent and Tunnel reconnect.
18. Mark the node ready only after every check passes.

Do not add a public SSH rule. Use the approved break-glass procedure when a node
cannot register. Do not print user data or tokens in logs.

The agent and Tunnel do not share an environment file. The agent process cannot
read the Tunnel token. The `cloudflared` process cannot read the node registration
token or node credential.
