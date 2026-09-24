# BUG: Node image scan fails on High Go-module findings in Traefik and cloudflared

- Status: fixed-pending-image-run
- Found: 2026-09-24, protected image run 36045727189 (exact main `3a39e42`, `build_local_image=true`)
- Owner: unassigned
- Spec: `.specs/image-go-binary-refresh/spec.md`

## Symptom

`build-local` built the QCOW2, extracted the rootfs, and passed the package policy for the
first time. It then failed step "Scan policy-validated rootfs SBOM" (Grype 0.117.0,
`--fail-on high --only-fixed`) with these High findings:

| Module                 | Installed | Fixed in        | Advisory                                 |
| ---------------------- | --------- | --------------- | ---------------------------------------- |
| google.golang.org/grpc | v1.82.1   | 1.82.2 / 1.83.1 | GHSA-2v4p-qf9q-27wj, GHSA-vp52-pcj8-j9qc |
| google.golang.org/grpc | v1.83.0   | 1.83.2 / 1.83.1 | GHSA-2v4p-qf9q-27wj, GHSA-vp52-pcj8-j9qc |
| golang.org/x/crypto    | v0.53.0   | 0.55.0 / 0.56.0 | GO-2026-6303, GO-2026-6354, GO-2026-6355 |
| golang.org/x/crypto    | v0.55.0   | 0.56.0          | GO-2026-6354, GO-2026-6355               |

Medium and Low findings (gorilla/websocket, otel exporters, klauspost/compress) were
listed but do not gate. `provider-image-smoke` was skipped.

## Cause

Step 128 (ADR 0103) builds Traefik `v3.7.11-gridora.1` from upstream commit `faa1eb5`
and cloudflared 2026.8.2 from commit `733bfb9`. Advisories published after 2026-08-25
now cover the grpc and x/crypto versions those commits pin. The gate is unchanged and
correct; the Go sources are stale.

## Fix

Move both binaries to current upstream releases (Traefik v3.7.13, cloudflared 2026.9.3)
and bump the one module cloudflared still pins below the fix (x/crypto → 0.56.0) through
the same fenced-diff mechanism ADR 0103 uses for Traefik. See the spec.
