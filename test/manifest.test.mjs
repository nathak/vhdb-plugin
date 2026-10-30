import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

test('the manifests agree on name and version', () => {
  const plugin = json('../.claude-plugin/plugin.json')
  const market = json('../.claude-plugin/marketplace.json')
  assert.equal(plugin.version, json('../package.json').version)
  assert.equal(market.plugins.length, 1)
  assert.equal(market.plugins[0].name, plugin.name)
  assert.equal(market.plugins[0].source, './')
  assert.equal(market.plugins[0].version, undefined, 'the version lives in plugin.json only')
})
