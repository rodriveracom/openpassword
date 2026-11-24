import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { OpenPassword } from '@openpassword/client'

export async function serve(client: () => Promise<OpenPassword>) {
  const server = new McpServer({ name: 'openpassword', version: '0.3.0' })
  const result = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  })
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
