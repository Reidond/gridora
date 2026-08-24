# Plugin authoring guide

A plugin contains game behavior. It does not contain provider, identity,
organization, scheduler, or repository behavior.

## Required facets

- The manifest declares identity, versions, resources, ports, and permissions.
- The control facet validates config and creates typed plans.
- The agent facet installs, configures, starts, stops, checks, backs up, and restores.
- The UI facet renders reviewed build-time components.

## Rules

1. Depend only on the plugin SDK packages.
2. Decode every external value with Effect Schema.
3. Use fixed typed commands. Do not accept a shell string.
4. Resolve every path below the assigned server root.
5. Declare each network host and port capability.
6. Redact plugin secrets before a log or operation event.
7. Pin every OCI image by digest.
8. Keep game binaries out of Gridora images.
9. Make install and update plans idempotent.
10. Keep config migrations forward-compatible and tested.
11. Do not import another plugin.
12. Register the plugin at build time.

## Required tests

Run manifest, install, repeat-install, update, invalid-config, config-golden,
lifecycle, health, log, backup, restore, mod, traversal, redaction, resource,
port, permission, and version-compatibility cases. Add a license note for the
server binary and mod sources.
