// A pipe from the broker is a lifetime handle, including when it dies from SIGKILL.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
const [mode, dir, binary, ...args] = process.argv.slice(2)
const child = spawn(binary, args, {
  stdio: [mode === 'workflow' ? 'pipe' : 'ignore', 'inherit', 'ignore'],
  env: { NODE_ENV: 'production', DOSTOEVSKY_TOKEN: process.env.DOSTOEVSKY_TOKEN },
})
const stop = () => child.kill('SIGTERM')
if (child.stdin) {
  child.stdin.on('error', () => {})
  process.stdin.pipe(child.stdin)
} else process.stdin.resume()
process.stdin.on('end', stop)
process.on('SIGTERM', stop)
child.on('error', () => process.exit(1))
child.on('exit', () => {
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
})
