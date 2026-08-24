# Architecture decision records

ADRs are immutable once accepted. A superseding ADR links to the prior record;
history is not rewritten. Status values are Proposed, Accepted, Superseded, or
Rejected.

- ADR 0001 defines the Hono and Effect Worker lifecycle.
- ADR 0002 defines D1 and Durable Object state ownership.
- ADR 0003 defines the systemd node agent.
- ADR 0004 defines Docker socket isolation.
- ADR 0005 defines Steam distribution boundaries.
- ADR 0006 defines Traefik and direct game ports.
- ADR 0007 defines the Cloudflare Access OAuth fallback.
- ADR 0008 defines provider idempotency.
- ADR 0009 defines the build-time plugin registry.
- ADR 0010 defines encrypted backup boundaries.
- ADR 0011 defines Contabo retirement semantics.
- ADR 0012 defines image promotion and release evidence.
- ADR 0013 defines the multi-organization model.
- ADR 0014 defines public authentication bootstrap.
- ADR 0015 defines organization deletion.
- ADR 0016 defines one-time authentication state.
- ADR 0017 defines node identity and bootstrap credentials.
- ADR 0018 defines leased outbox delivery.
- ADR 0019 defines uncertain provider create behavior.
- ADR 0020 defines secret envelope encryption.
- ADR 0021 defines client mutation idempotency.
- ADR 0022 defines the default-deny game network.
- ADR 0023 defines Tunnel credential delivery.
- ADR 0024 defines verified private backup snapshots and atomic restore cutover.
- ADR 0025 defines invitation email delivery.
- ADR 0026 defines versioned deterministic invitation and node credential keyrings.
- ADR 0027 defines fail-closed disk quota enforcement for game deployments.
- ADR 0028 defines the Cloudflare Secrets Store key-encryption adapter.
- ADR 0029 defines the dedicated project-quota filesystem.
- ADR 0030 defines authenticated chunked R2 backup objects.
- ADR 0031 defines server-enforced registration modes.
- ADR 0032 defines atomic lifecycle reservation and deterministic Workflow start.
- ADR 0033 defines sealed Tunnel credential installation.
- ADR 0034 defines immutable tenant audit export.
- ADR 0035 defines organization policy admission.
- ADR 0036 defines authoritative, read-only D1 game-server planning.
- ADR 0037 defines provider account validation and independent account and credential revisions.
- ADR 0038 defines atomic, policy-fenced node provision acceptance and fixed provider dispatch.
- ADR 0039 defines bounded, read-only, tenant-bound orphan provider reconciliation.
- ADR 0040 defines bounded, machine-authenticated, fail-closed agent observation ingestion.
- ADR 0041 defines organization-scoped realtime authorization and single-use tickets.
- ADR 0042 defines authoritative, redacted, read-only game desired-state preview.
- ADR 0043 defines leased, adopt-only execution of accepted node provider work.
- ADR 0044 defines crash-safe, fail-closed node-agent observation publication.
- ADR 0045 defines the promoted-image bootstrap, image attestation, and fixed firewall observation handoff.
- ADR 0046 defines bounded provider create transports and adopt-only ambiguity recovery.
- ADR 0047 defines Access-authenticated invitation acceptance for an existing identity.
- ADR 0048 defines separate Platform Administrator authority, provider secrets, and tenant allocations.
- ADR 0049 defines strict public node intent, signed provider execution, and atomic early registration composition.
- ADR 0050 defines observed game-server lifecycle execution and isolated plugin jobs.
- ADR 0051 defines authenticated backup and source-preserving restore orchestration.
- ADR 0052 defines destructive lifecycle cancellation and provider-retirement truth.
- ADR 0053 defines bounded tenant-scoped logs, aggregate health, telemetry, realtime delivery, and crash-safe local spool durability.
- ADR 0054 defines scheduled, read-only, tenant-bound orphan reconciliation.
- ADR 0055 defines the open registration default and truthful local-only slug validation.
- ADR 0056 defines organization-scoped automation identities, one-time credentials, and immediate revocation.
- ADR 0057 defines platform node-image lifecycle, proof-bound provider registration, and safe recovery.
- ADR 0058 defines exact account-bound non-destructive node runtime lifecycle execution.
- ADR 0059 defines signed node-agent self-update, immutable root activation, and exact rollback authority.
- ADR 0060 defines bounded scheduled organization-policy reconciliation and fenced lifecycle acceptance.
- ADR 0061 defines atomic organization self-leave, response-loss adoption, and immediate realtime revocation.
- ADR 0062 defines race-safe health aggregation and bounded tenant-scoped health and log reads.
- ADR 0063 defines Viewer access to tenant-scoped, read-only audit history.
- ADR 0064 defines complete versioned audit envelopes, exact-operation fences,
  platform audit export, and legacy compatibility evidence.
- ADR 0065 defines composed node lifecycle control, operation-bound retirement
  evidence, root-filesystem image evidence, and fail-closed provider-image
  smoke release gating.
- ADR 0066 defines production machine telemetry and log publication.
- ADR 0067 defines durable operations for core organization mutations.
- ADR 0068 defines composed backup, restore, scheduling, cancellation,
  organization deletion, and truthful generic operation-detail evidence.
- ADR 0069 defines terminal game lifecycle completion audit evidence and
  operation-bound move, DNS, backup, and observation composition.
- ADR 0070 supersedes the telemetry retry, epoch, live-revocation, and R2 cleanup portions of ADR 0066.
- ADR 0071 defines operating-system-backed CLI refresh-token storage.
- ADR 0072 defines durable no-fit server planning, canonical apply intent,
  private immutable reviewed-node facts, authoritative readiness, and
  parent-scoped node-retirement compensation, plus opaque exact-offer
  commercial review proof.
- ADR 0073 defines one multi-domain Access application for console and API
  browser cookie composition.
- ADR 0074 defines environment-rendered Cloudflare Worker bindings, exact
  browser CORS, and locked R2 Terraform state.
- ADR 0075 requires an artifact-bearing protected Node image run for release
  evidence.
- ADR 0076 binds node rebuild and retirement to exact provider effects and
  terminal audit evidence.
- ADR 0077 defines generation-fenced backup recovery, retention deletion, and
  organization-deletion evidence.
- ADR 0078 makes telemetry archive retry decisions adoptable after response
  loss.
- ADR 0079 defines immutable declarative game-server manifests, drafts, clones,
  and one-shot schedules.
- ADR 0080 defines bounded third-party Arma Reforger mod metadata resolution,
  dependency expansion, and plan-local provenance.
- ADR 0081 defines reviewed plugin installation, staged configuration and mod
  activation, rollback, and plugin-level health.
- ADR 0082 defines bounded root-owned plugin egress leases and exact
  failed-node forced cleanup.
- ADR 0083 defines bounded, tenant-scoped, non-destructive symmetry checks for
  containers, ports, DNS, Tunnels, and R2 backup objects.
- ADR 0084 defines reproducible clean-runner release evidence, cross-platform
  dependency locks, and reviewer-gated publication boundaries.
- ADR 0085 defines the disposable Docker VPS and Arma simulation boundary,
  environment-isolated Cloudflare resources, and protected production ingress.
- ADR 0086 defines truthful single-owner deployment approval, mandatory
  automated release gates, and ephemeral release evidence.
- ADR 0087 defines the Linux KVM firewall proof at the Docker host-DNAT boundary
  instead of same-bridge layer-2 traffic.
- ADR 0088 moved non-secret kernel proofs into required pull-request validation;
  ADR 0089 supersedes its quota-container execution boundary.
- ADR 0089 runs the project-quota proof on the ephemeral Ubuntu host inside a
  private mount namespace while retaining the containerized firewall proof.
- ADR 0090 explicitly loads and verifies the hosted kernel's version-2 quota
  format module before the private project-quota proof.
- ADR 0091 installs the matching Ubuntu extra-module package on the disposable
  runner before it loads the quota format module.
- ADR 0092 boots the pinned Ubuntu autoinstall through explicit GRUB kernel and
  initrd commands instead of depending on mutable menu-editor line positions.
- ADR 0093 creates the private guest directory required by Packer's
  content-only asset upload before the SCP provisioner runs.
- ADR 0094 gives the key-authenticated Packer build account a validated
  temporary sudo grant and removes it with the build key before shutdown.
- ADR 0095 creates the journald drop-in directory explicitly before installing
  the immutable node logging policy into a minimal Ubuntu guest.
- ADR 0096 scopes every signed agent-update manifest assertion explicitly and
  makes guest provisioner failures report their exact non-secret command.
- ADR 0097 installs every fixed unit executable before the real Ubuntu guest
  runs systemd verification against the immutable unit set.
- ADR 0098 makes the ephemeral signing runner's kernel readable to libguestfs
  and proves the read-only extraction appliance before the QCOW2 build starts.
- ADR 0099 streams only the unique package database from the guest archive while
  retaining the complete rootfs as the scan, checksum, and signature evidence.
- ADR 0100 makes every protected image evidence boundary independently visible
  while preserving its fail-closed order and artifact-upload fence.
