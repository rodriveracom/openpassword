import { fileURLToPath } from 'node:url'
import { service } from './service.ts'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
process.umask(0o077)
const dir = resolve(process.env.OPENPASSWORD_HOME || homedir() + '/.openpassword')
const api = service(
  dir,
  process.env.OPENPASSWORD_WEB_ORIGIN || 'http://localhost:3000',
  undefined,
  undefined,
  true,
  { engineBin: fileURLToPath(new URL('../engine-bin/', import.meta.url)) },
)
await api.listen({ host: '127.0.0.1', port: Number(process.env.OPENPASSWORD_PORT || 4141) })
console.log(
  'OpenPassword broker is listening. Use openpassword setup-code on the host or setup-code --ssh from your laptop for first-time setup.',
)
process.on('SIGUSR2', () => api.getDecorator<() => void>('beginDrain')())
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void api.close())
