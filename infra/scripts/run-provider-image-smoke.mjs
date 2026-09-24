#!/usr/bin/env node
// Paid provider image smoke entry point (ADR 0106).
//
// Build the bundled CLI first with the pinned toolchain:
//   pnpm --filter @gridora/provider-image-smoke build
//
// The CLI reads environment inputs only. It fails before any provider request
// unless GRIDORA_LIVE_TEST is exactly "true". It prints redacted evidence to
// stdout and $GITHUB_STEP_SUMMARY and exits non-zero on any failure or on any
// cleanup that the provider did not confirm.
import { main } from '../../packages/provider-image-smoke/dist/cli.mjs'

process.exitCode = await main(process.env)
