import { resolve } from 'node:path'
import { service } from '../../server/service.ts'
const api = service(
  process.argv[2],
  undefined,
  async () => Response.json({ data: { id: '123' } }),
  false,
  false,
  { engineBin: resolve('engine-bin') },
)
const url = await api.listen({ host: '127.0.0.1', port: 0 })
process.send?.(url)
