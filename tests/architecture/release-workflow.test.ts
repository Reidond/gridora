import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('release workflow evidence', () => {
  it('keeps one routine CI workflow and makes image work explicitly manual', () => {
    expect(readdirSync(resolve(process.cwd(), '.github/workflows')).sort()).toEqual([
      'ci.yml',
      'image.yml',
      'release.yml',
    ])

    const ci = parse(read('.github/workflows/ci.yml'))
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push'])
    expect(Object.keys(ci.jobs)).toEqual(['verify'])
    expect(ci.jobs.verify['runs-on']).toBe('ubuntu-24.04')
    expect(ci.jobs.verify.strategy).toBeUndefined()
    expect(ci.jobs.verify.steps).toContainEqual({
      name: 'Smoke-test the packaged CLI binary',
      run: 'pnpm test:cli-smoke',
    })
    expect(JSON.parse(read('package.json')).scripts['test:cli-smoke']).toBe(
      'node infra/scripts/smoke-cli-binary.mjs',
    )

    const workflow = parse(read('.github/workflows/image.yml'))
    const triggers = workflow.on

    expect(Object.keys(triggers)).toEqual(['workflow_dispatch'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs['build-local'].permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
    })

    const smoke = workflow.jobs['provider-image-smoke']
    expect(workflow.on.workflow_dispatch.inputs.provider_image_smoke_ttl_minutes).toMatchObject({
      type: 'string',
      default: '30',
    })
    expect(workflow.on.workflow_dispatch.inputs.provider_image_smoke_provider).toMatchObject({
      type: 'choice',
      options: ['simulated', 'ovh', 'contabo'],
      default: 'simulated',
    })
    expect(workflow.on.workflow_dispatch.inputs.live_test).toMatchObject({
      type: 'boolean',
      default: false,
    })
    expect(smoke).toMatchObject({
      name: 'provider-image-smoke',
      needs: 'build-local',
      environment: 'image-signing',
      'timeout-minutes': 90,
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(smoke.if).toContain("github.event_name == 'workflow_dispatch'")
    expect(smoke.if).toContain('inputs.build_local_image')
    expect(smoke.if).toContain("github.ref == 'refs/heads/main'")
    expect(smoke.steps.map((step: { name?: string }) => step.name)).toEqual(
      expect.arrayContaining([
        'Validate bounded simulated smoke inputs',
        'Verify the exact signed artifact selected for smoke',
        'Exercise Arma lifecycle on the disposable VPS simulation',
        'Run the paid provider image smoke',
        'Remove the short-lived artifact locator',
      ]),
    )
    const source = read('.github/workflows/image.yml')
    expect(source).toContain('[[ "$PROVIDER" == simulated ]]')
    expect(source).toContain('pnpm test:arma-sim')
    expect(source).toContain('paid provider mutation: not performed')
    expect(source).toContain('deterministic reviewed stand-in, not Bohemia binaries')
  })

  it('gates the paid provider smoke on live_test before any provider call', () => {
    const workflow = parse(read('.github/workflows/image.yml'))
    const steps: {
      name?: string
      if?: string
      run?: string
      env?: Record<string, string>
      uses?: string
    }[] = workflow.jobs['provider-image-smoke'].steps
    const index = (name: string) => steps.findIndex((step) => step.name === name)
    const gateIndex = index('Require the live-test gate for a paid provider')
    const gate = steps[gateIndex]!
    // The gate runs unconditionally and before the artifact download or any paid step.
    expect(gate.if).toBeUndefined()
    const download = steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact'))
    expect(gateIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeLessThan(download)
    expect(gateIndex).toBeLessThan(index('Run the paid provider image smoke'))
    const runGate = (provider: string, liveTest: string) =>
      spawnSync('bash', ['-euo', 'pipefail', '-c', gate.run!], {
        env: { PATH: process.env.PATH, PROVIDER: provider, LIVE_TEST: liveTest },
        encoding: 'utf8',
      })
    for (const provider of ['ovh', 'contabo']) {
      const denied = runGate(provider, 'false')
      expect(denied.status).toBe(1)
      expect(denied.stderr).toContain('requires live_test=true; no provider call was made')
      expect(runGate(provider, 'true').status).toBe(0)
    }
    expect(runGate('simulated', 'false').status).toBe(0)
    expect(runGate('hetzner', 'true').status).toBe(1)

    // The simulated lane keeps its original validation and simulation steps only.
    expect(steps[index('Validate bounded simulated smoke inputs')]!.if).toBe(
      "inputs.provider_image_smoke_provider == 'simulated'",
    )
    expect(steps[index('Exercise Arma lifecycle on the disposable VPS simulation')]!.if).toBe(
      "inputs.provider_image_smoke_provider == 'simulated'",
    )
    const paid = steps[index('Run the paid provider image smoke')]!
    expect(paid.if).toBe("inputs.provider_image_smoke_provider != 'simulated' && inputs.live_test")
    expect(paid.run).toContain('node infra/scripts/run-provider-image-smoke.mjs')
    expect(paid.run).toContain('echo "::add-mask::$locator"')
    expect(paid.run).not.toContain('set -x')
    expect(paid.run).not.toMatch(/echo "?\$\{?(AWS_SECRET|GRIDORA_SMOKE_(OVH|CONTABO))/)
    expect(paid.env?.GRIDORA_LIVE_TEST).toBe('${{ inputs.live_test }}')
    for (const [name, value] of Object.entries(paid.env ?? {}))
      if (value.includes('secrets.'))
        expect(value, `${name} must come from an image-signing secret`).toMatch(
          /secrets\.GRIDORA_SMOKE_[A-Z0-9_]+/,
        )
    const cleanupIndex = index('Remove the short-lived artifact locator')
    expect(steps[cleanupIndex]!.if).toBe(
      "always() && inputs.provider_image_smoke_provider != 'simulated' && inputs.live_test",
    )
    expect(cleanupIndex).toBeGreaterThan(index('Run the paid provider image smoke'))
  })

  it('separates read-only evidence verification from release publication', () => {
    const workflow = parse(read('.github/workflows/release.yml'))
    const verify = workflow.jobs['verify-evidence']
    const release = workflow.jobs.release
    const source = read('.github/workflows/release.yml')
    const imageEvidence = read('infra/scripts/verify-release-image-evidence.sh')

    expect(Object.keys(workflow.on)).toEqual(['push'])
    expect(workflow.on.push.tags).toEqual(['v*'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(verify.permissions).toEqual({
      actions: 'read',
      contents: 'read',
    })
    expect(release.needs).toBe('verify-evidence')
    expect(release.environment).toBeUndefined()
    expect(release.permissions).toEqual({
      actions: 'read',
      contents: 'write',
      'id-token': 'write',
    })
    const governance = verify.steps.find(
      (step: { name?: string }) => step.name === 'Verify the remote tag and main provenance',
    )
    const workflowEvidence = verify.steps.find(
      (step: { name?: string }) =>
        step.name === 'Require successful workflows for the exact tag commit',
    )

    expect(governance.env.EVIDENCE_TOKEN).toBe('${{ github.token }}')
    expect(governance.env.GH_TOKEN).toBeUndefined()
    expect(workflowEvidence.env.GH_TOKEN).toBe('${{ github.token }}')
    expect(source).not.toContain('RELEASE_EVIDENCE_TOKEN')
    expect(source).not.toContain('installation/repositories')
    expect(source).not.toContain('repos/$REPOSITORY/commits/$TAG_SHA/pulls')
    expect(source).toContain('require_successful_workflow ci.yml CI')
    expect(source).not.toContain('security.yml')
    expect(source.match(/bash infra\/scripts\/verify-release-image-evidence\.sh/g)).toHaveLength(3)
    const revalidateStepIndex = release.steps.findIndex(
      (step: { name?: string }) =>
        step.name === 'Revalidate Node image evidence before publication',
    )
    const sourceArchiveStepIndex = release.steps.findIndex(
      (step: { name?: string }) => step.name === 'Create reproducible source archive',
    )
    expect(revalidateStepIndex).toBeGreaterThan(0)
    expect(revalidateStepIndex).toBeLessThan(sourceArchiveStepIndex)
    expect(release.steps[revalidateStepIndex]).toMatchObject({
      env: {
        GH_TOKEN: '${{ github.token }}',
        REPOSITORY: '${{ github.repository }}',
        TAG_SHA: '${{ github.sha }}',
      },
    })
    expect(imageEvidence).toContain('.event == "workflow_dispatch"')
    expect(imageEvidence).toContain('.head_branch == "main"')
    expect(imageEvidence).toContain('attempts/$run_attempt/jobs')
    expect(imageEvidence).toContain('gridora-node-${run_id}-${run_attempt}')
    expect(imageEvidence).toContain('.name == "provider-image-smoke"')
    expect(imageEvidence).toContain('.expired == false')
    expect(imageEvidence).toContain('.size_in_bytes | type == "number" and . > 0')
    expect(imageEvidence).toContain('.workflow_run.head_sha == $sha')
    const publish = release.steps.find(
      (step: { name?: string }) => step.name === 'Publish immutable release assets',
    )
    expect(publish.run).toMatch(
      /test "\$\(resolve_remote_tag\)" = "\$TAG_SHA"\n\s*GH_TOKEN="\$PUBLISH_TOKEN" REPOSITORY="\$REPOSITORY" TAG_SHA="\$TAG_SHA" \\\n\s*bash infra\/scripts\/verify-release-image-evidence\.sh\n\s*GH_TOKEN="\$PUBLISH_TOKEN" gh release create/,
    )
    expect(source.match(/test "\$\(resolve_remote_tag\)" = "\$TAG_SHA"/g)).toHaveLength(3)
    expect(source).toContain('--target "$TAG_SHA"')
  })
})
