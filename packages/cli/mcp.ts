import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { OpenPassword } from '@openpassword/client'

export async function serve(client: () => Promise<OpenPassword>) {
  const server = new McpServer({ name: 'openpassword', version: '0.5.0' })
  const result = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  })
  server.registerTool(
    'models',
    { description: 'List models available under this grant.' },
    async () => result(await (await client()).request('/v1/models')),
  )
  server.registerTool(
    'chat',
    {
      description:
        'Send a metered model request under this grant. Reuse the idempotency key when retrying the same request.',
      inputSchema: {
        model: z.string().min(1),
        prompt: z.string().max(64000),
        max_tokens: z.number().int().positive(),
        idempotency_key: z.string().min(1).max(200),
      },
    },
    async (b) =>
      result(await (await client()).chat(b.model, b.prompt, b.max_tokens, b.idempotency_key)),
  )
  server.registerTool(
    'whoami',
    { description: 'Verify this profile against the broker and return its stable grant ID.' },
    async () => result(await (await client()).request('/v1/whoami')),
  )
  server.registerTool(
    'activity',
    {
      description: 'Read recent events for this grant, or continue after a cursor.',
      inputSchema: { after: z.number().int().nonnegative().optional() },
    },
    async ({ after }) =>
      result(
        await (
          await client()
        ).request('/v1/activity?wait=0' + (after === undefined ? '' : '&after=' + after)),
      ),
  )
  server.registerTool(
    'connections',
    { description: 'List provider connections available under this agent grant.' },
    async () => result(await (await client()).connections()),
  )
  server.registerTool(
    'capabilities',
    {
      description: 'Inspect authorized operations, resources and limits for the paired connection.',
    },
    async () => result(await (await client()).request('/v1/capabilities')),
  )
  server.registerTool(
    'invoke',
    {
      description:
        'Invoke an authorized operation. Use a unique idempotency key per intended action and reuse it when retrying the same action after approval.',
      inputSchema: {
        connection_id: z.string().min(1),
        operation_id: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()),
        idempotency_key: z.string().min(1),
        expect: z
          .object({ external_identity: z.string().min(1), connection_revision: z.string().min(1) })
          .optional()
          .describe(
            'The identity and revision from capabilities, for operations requiring an exact credential binding.',
          ),
      },
    },
    async (b) =>
      result(
        await (
          await client()
        ).invoke(b.connection_id, b.operation_id, b.arguments, b.idempotency_key, b.expect),
      ),
  )
  await server.connect(new StdioServerTransport())
}
