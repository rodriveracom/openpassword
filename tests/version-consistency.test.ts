import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json')) as { version: string }

test('package.json holds the version of the newest CHANGELOG heading', () => {
  const newest = read('CHANGELOG.md').match(/^## (\d+\.\d+\.\d+)\b/m)?.[1]
  assert.ok(newest, 'CHANGELOG.md has a version heading')
  assert.equal(pkg.version, newest)
})

test('every other version source agrees with package.json', () => {
  const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> }
  assert.equal(lock.version, pkg.version, 'package-lock.json top-level version')
  assert.equal(lock.packages[''].version, pkg.version, 'package-lock.json root package version')
  // The MCP server string is either read from package.json or a literal that must match it.
  const literal = read('packages/cli/mcp.ts').match(/new McpServer\(\{[^}]*version:\s*'([^']+)'/)?.[1]
  if (literal !== undefined) assert.equal(literal, pkg.version, 'packages/cli/mcp.ts version literal')
  // `openpassword version` must name the release that carries it.
  const cli = read('packages/cli/index.ts').match(/'OpenPassword CLI (\d+\.\d+\.\d+) · protocol/)?.[1]
  assert.equal(cli, pkg.version, 'packages/cli/index.ts version output')
  assert.match(read('PARITY.md'), new RegExp('working ' + pkg.version.replace(/\./g, '\\.') + ' candidate'), 'PARITY.md names the version')
})
