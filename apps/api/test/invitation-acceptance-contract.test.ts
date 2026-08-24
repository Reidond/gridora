import { describe, expect, it } from 'vitest'
import { openApiDocument, unsupportedApiRoutes } from '../src/contracts.js'

describe('existing-identity invitation acceptance contract', () => {
  it('publishes the exact token-path POST without a body and with durable idempotency', () => {
    const operation = (
      openApiDocument.paths as Readonly<Record<string, Readonly<Record<string, unknown>>>>
    )['/v1/invitations/{token}']
    expect(operation).toBeUndefined()

    const accept = (
      openApiDocument.paths as Readonly<
        Record<
          string,
          Readonly<
            Record<
              string,
              {
                readonly operationId: string
                readonly parameters: readonly {
                  readonly in: string
                  readonly name: string
                  readonly schema: Readonly<Record<string, unknown>>
                }[]
                readonly requestBody?: unknown
                readonly responses: Readonly<Record<string, unknown>>
              }
            >
          >
        >
      >
    )['/v1/invitations/{token}/actions/accept']?.post

    expect(accept).toMatchObject({
      operationId: 'acceptInvitation',
      parameters: [
        {
          in: 'path',
          name: 'token',
          required: true,
          schema: {
            type: 'string',
            minLength: 64,
            maxLength: 64,
            pattern: '^[0-9a-f]{64}$',
          },
        },
        {
          in: 'header',
          name: 'Idempotency-Key',
          required: true,
          schema: {
            type: 'string',
            minLength: 8,
            maxLength: 255,
          },
        },
      ],
      responses: { '200': { description: 'Success' } },
    })
    expect(accept?.requestBody).toBeUndefined()
    expect(accept?.parameters.some(({ name }) => name === 'Idempotency-Key')).toBe(true)
    expect(
      unsupportedApiRoutes.some(
        ({ method, path }) =>
          method === 'post' && path === '/v1/invitations/{token}/actions/accept',
      ),
    ).toBe(false)
  })
})
