import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
export class EngineCli {
  private child
  private lines
  constructor(binary: string, database: string, epochDir?: string) {
    this.child = spawn(
      epochDir ? process.execPath : binary,
      epochDir
        ? [
            fileURLToPath(new URL('./engine-guardian.ts', import.meta.url)),
            'workflow',
            epochDir,
            binary,
            database,
          ]
        : [database],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { NODE_ENV: 'production' },
      },
    )
    this.child.on('error', () => {})
    this.child.stdin.on('error', () => {})
    this.lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]()
  }
  // The caller serializes commands. Every failed request terminates the upstream CLI.
  async call(request: Record<string, unknown>) {
    if (this.child.exitCode !== null || this.child.stdin.destroyed)
      throw Error('Workflow engine unavailable')
    const timeout = setTimeout(() => this.child.kill('SIGKILL'), 10000)
    try {
      this.child.stdin.write(JSON.stringify(request) + '\n')
      const line = await this.lines.next()
      if (line.done) throw Error('Workflow engine closed')
      return JSON.parse(line.value)
    } finally {
      clearTimeout(timeout)
    }
  }
  close() {
    this.child.stdin.end()
    this.child.kill()
  }
}
