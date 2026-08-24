import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('release workflow evidence', () => {
  it('runs image validation for every exact main commit and every pull request', () => {
    const workflow = parse(read('.github/workflows/image.yml'))
    const triggers = workflow.on

    expect(triggers.push.branches).toEqual(['main'])
    expect(triggers.pull_request).toEqual({})
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs['build-local'].permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
    })

    const smoke = workflow.jobs['provider-image-smoke']
    expect(workflow.on.workflow_dispatch.inputs.provider_image_smoke_approved).toMatchObject({
      type: 'boolean',
      default: false,
    })
    expect(workflow.on.workflow_dispatch.inputs.provider_image_smoke_ttl_minutes).toMatchObject({
      type: 'string',
      default: '30',
    })
    expect(workflow.on.workflow_dispatch.inputs.provider_image_smoke_provider).toMatchObject({
      type: 'choice',
      options: ['simulated'],
      default: 'simulated',
    })
    expect(smoke).toMatchObject({
      name: 'provider-image-smoke',
      needs: 'build-local',
      environment: 'provider-image-smoke',
      'timeout-minutes': 60,
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(smoke.if).toContain("github.event_name == 'workflow_dispatch'")
    expect(smoke.if).toContain('inputs.build_local_image')
    expect(smoke.if).toContain("github.ref == 'refs/heads/main'")
    expect(smoke.steps.map((step: { name?: string }) => step.name)).toEqual(
      expect.arrayContaining([
        'Require explicit protected simulated smoke approval and bounded inputs',
        'Verify the exact signed artifact selected for smoke',
        'Exercise Arma lifecycle on the disposable VPS simulation',
      ]),
    )
    const source = read('.github/workflows/image.yml')
    expect(source).toContain('[[ "$PROVIDER" == simulated ]]')
    expect(source).toContain('pnpm test:arma-sim')
    expect(source).toContain('paid provider mutation: not performed')
    expect(source).toContain('deterministic reviewed stand-in, not Bohemia binaries')
  })

  it('separates read-only evidence verification from release publication', () => {
    const workflow = parse(read('.github/workflows/release.yml'))
    const verify = workflow.jobs['verify-evidence']
    const release = workflow.jobs.release
    const source = read('.github/workflows/release.yml')
    const imageEvidence = read('infra/scripts/verify-release-image-evidence.sh')

    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(verify.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      'pull-requests': 'read',
    })
    expect(release.needs).toBe('verify-evidence')
    expect(release.permissions).toEqual({
      actions: 'read',
      contents: 'write',
      'id-token': 'write',
    })
    expect(release.environment).toBe('production-release')
    const governance = verify.steps.find(
      (step: { name?: string }) => step.name === 'Verify the remote tag and merged main provenance',
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
    expect(source).toContain('repos/$REPOSITORY/commits/$TAG_SHA/pulls')
    expect(source).toContain('.base.ref == "main"')
    expect(source).toContain('.merge_commit_sha == $sha')
    expect(source).toContain('require_successful_workflow ci.yml CI')
    expect(source).toContain('require_successful_workflow security.yml Security')
    expect(source.match(/bash infra\/scripts\/verify-release-image-evidence\.sh/g)).toHaveLength(3)
    const revalidateStepIndex = release.steps.findIndex(
      (step: { name?: string }) =>
        step.name === 'Revalidate protected Node image evidence after production approval',
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
