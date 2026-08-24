# systemd packaging

The canonical unit is `infra/images/systemd/gridora-agent.service`. Keeping one
unit avoids packaging an agent service with security or readiness settings that
diverge from the node image.
