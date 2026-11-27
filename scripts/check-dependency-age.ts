import { execFileSync } from 'node:child_process'
// Gate operator on the build host; no sudo. Check the locked transitive graph before installing it.
import { readFileSync } from 'node:fs'
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const packages = new Map<string, Set<string>>()
for (const [path, entry] of Object.entries(lock.packages) as [
  string,
  {
    link?: boolean
    inBundle?: boolean
    version?: string
    resolved?: string
    integrity?: string
    name?: string
  },
][]) {
  if (!path.includes('node_modules/')) continue
  if (entry.link) {
    if (
      !entry.resolved ||
      !/^packages\/[a-z]+$/.test(entry.resolved) ||
      lock.packages[entry.resolved]?.name !== path.slice('node_modules/'.length)
    )
      throw Error('Unknown workspace link ' + path)
    continue
  }
  if (entry.inBundle && !path.includes('/node_modules/'))
    throw Error('Missing registry parent: ' + path)
  const name = entry.name || path.split('node_modules/').at(-1)!
  if (
    !entry.version ||
    (!entry.inBundle &&
      (!entry.resolved?.startsWith('https://registry.npmjs.org/') ||
        !entry.integrity?.startsWith('sha512-')))
  )
    throw Error('Unverified registry dependency: ' + name)
  if (!packages.has(name)) packages.set(name, new Set())
  packages.get(name)!.add(entry.version)
}
const work = [...packages],
  cutoff = Date.now() - 14 * 86400000,
  failures: string[] = []
async function worker() {
  for (let job = work.pop(); job; job = work.pop()) {
    const [name, versions] = job
    try {
      const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name), {
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      })
      if (!response.ok) throw Error()
      const meta = await response.json()
      for (const version of versions) {
        const published = Date.parse(meta.time?.[version])
        if (!Number.isFinite(published) || published > cutoff)
          failures.push(name + '@' + version + ' ' + (meta.time?.[version] ?? 'unknown date'))
      }
    } catch {
      failures.push(name + ' registry metadata unavailable')
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker))
if (failures.length) throw Error('Dependency age gate refused:\n' + failures.sort().join('\n'))
console.log('Verified minimum age for ' + packages.size + ' registry packages')

// Source pins carry Ephemeral's complete third-party vendor tree on the offline gate.
const vendored = execFileSync(
  'tar',
  ['-xOzf', 'vendor/dogfood/ephemeral.tar.gz', 'vendor/modules.txt'],
  { encoding: 'utf8' },
)
const modules = [...vendored.matchAll(/^# ([a-z0-9./_-]+) (v[0-9A-Za-z.+-]+)$/gm)]
if (
  !modules.length ||
  modules.length !== vendored.split('\n').filter((line) => line.startsWith('# ')).length
)
  throw Error('Unrecognized Go dependency list')
for (const [, name, version] of modules) {
  const response = await fetch(
    'https://proxy.golang.org/' + name + '/@v/' + encodeURIComponent(version) + '.info',
    { redirect: 'error', signal: AbortSignal.timeout(20000) },
  )
  if (!response.ok) throw Error('Missing publication metadata for ' + name)
  const metadata = await response.json(),
    published = Date.parse(metadata.Time)
  if (metadata.Version !== version || !Number.isFinite(published) || published > cutoff)
    throw Error('Dependency age gate refused ' + name + '@' + version)
}
console.log('Verified minimum age for ' + modules.length + ' vendored Go modules')
