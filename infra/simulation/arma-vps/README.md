# Simulated Arma Reforger VPS

This acceptance fixture runs Gridora's real reviewed Arma Reforger plugin,
agent game runtime, isolated job runner, quota contract seam, Docker Engine
adapter, and node-image nftables policy inside a privileged disposable
container. A second nested, unprivileged game container provides deterministic
stand-ins for SteamCMD, the Arma server, and the protocol health query.

Run it with:

```sh
pnpm test:arma-sim
```

The proof covers installation receipts, configuration and mod activation,
published UDP player and query ports, plugin health, backup-before-update,
failed configuration rollback, stop, and restart. It never downloads Steam or
Arma content, accepts Steam credentials, mounts the host Docker socket, or
creates provider infrastructure. The outer container is privileged only so it
can operate its own nested Docker daemon and is removed after the test.

This is the deterministic provider/VPS simulation lane. It is not evidence of
a paid-provider mutation or execution of Bohemia Interactive binaries.
