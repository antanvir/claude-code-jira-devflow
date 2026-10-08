import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/constants'
import * as fmt from '../hooks/format'

test('email is user-wide, the rest is per repo', async () => {
  const { user, repo } = fmt.splitConfig({ ...DEFAULT_CONFIG, email: 'a@b.c', labels: ['x'] })
  expect(user).toEqual({ email: 'a@b.c' })
  expect(repo.labels).toEqual(['x'])
  expect('email' in repo).toBe(false)
})

test('usage bars switch colour at 60% and 85%', async () => {
  expect(fmt.levelColor(42)).toBe('success')
  expect(fmt.levelColor(60)).toBe('warning')
  expect(fmt.levelColor(85)).toBe('error')
  expect(fmt.bar(50)).toBe('█████░░░░░')
})

test('usage snapshot keeps rate limits and context only', async () => {
  const snapshot = fmt.toUsageSnapshot({
    startedAt: 0,
    context: { window: 200_000, percent: 61 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42 }],
    cost: { usd: 18.2 },
  })
  expect(snapshot.fiveHour?.percent).toBe(42)
  expect('onDemand' in snapshot).toBe(false)
  expect(snapshot.context?.label).toBe('61%')
  expect(snapshot.weekly).toBe(undefined)
})

test('commit messages lose attribution lines', async () => {
  const message = fmt.stripAttribution('PROJ-1: Fix fee\n\nCo-Authored-By: Claude <noreply@anthropic.com>')
  expect(message).toBe('PROJ-1: Fix fee')
})

test('only touched files git still lists are kept', async () => {
  const files = ['C:\\repo\\src\\a.ts', 'C:\\repo\\src\\b.ts']
  expect(fmt.filterDirty(files, ' M src/a.ts\n')).toEqual(['C:\\repo\\src\\a.ts'])
})

test('porcelain -z entries keep leading-space codes and skip rename sources', async () => {
  const output = ' M src/a.ts\0?? new dir/b.md\0R  c.ts\0old-c.ts\0 D gone.ts\0'
  expect(fmt.parsePorcelainZ(output)).toEqual([
    { path: 'src/a.ts', isDeleted: false },
    { path: 'new dir/b.md', isDeleted: false },
    { path: 'c.ts', isDeleted: false },
    { path: 'gone.ts', isDeleted: true },
  ])
})

test('a turn changes files that became dirty or whose content changed', async () => {
  const before = { '/r/a.ts': 'h1', '/r/b.ts': 'h2' }
  const after = { '/r/a.ts': 'h1', '/r/b.ts': 'h3', '/r/c.ts': 'h4' }
  expect(fmt.changedSince(before, after)).toEqual(['/r/b.ts', '/r/c.ts'])
})

test('plan copies are named <TICKET>-<name>.md beside the original', async () => {
  const path = 'C:\\Users\\me\\.claude\\plans\\sleepy-otter.md'
  expect(fmt.namedPlanPath(path, 'PROJ-1234', fmt.slugify('Refund Fee Fix!'))).toBe(
    'C:\\Users\\me\\.claude\\plans/PROJ-1234-refund-fee-fix.md',
  )
  expect(fmt.headingSlug('# Plan: Fix refund double count\n...')).toBe('fix-refund-double-count')
})

test('update prompt includes only the enabled parts', async () => {
  const prompt = fmt.updateTicketPrompt('PROJ-1', { ...DEFAULT_CONFIG, email: 'a@b.c', labels: ['team-a', 'qa'], updateParts: ['labels'] })
  expect(prompt.includes('append labels "team-a", "qa"')).toBe(true)
  expect(prompt.includes('status')).toBe(false)
})

test('prompts use the bundled, plugin-namespaced skills', async () => {
  expect(fmt.updateTicketPrompt('PROJ-1', DEFAULT_CONFIG).includes('jira-devflow:update-jira-ticket skill')).toBe(true)
  expect(fmt.writeAcPrompt('PROJ-1').includes('jira-devflow:write-acceptance-criteria skill')).toBe(true)
})

test('labels and commit subject/body round-trip through single-line inputs', async () => {
  expect(fmt.parseLabels(' a, b ,,c ')).toEqual(['a', 'b', 'c'])
  expect(fmt.labelsText(['a', 'b'])).toBe('a, b')
  expect(fmt.splitMessage('PROJ-1: Fix fee\n\nAdd tests')).toEqual({ subject: 'PROJ-1: Fix fee', body: 'Add tests' })
  expect(fmt.joinMessage('PROJ-1: Fix fee', 'Add tests')).toBe('PROJ-1: Fix fee\nAdd tests')
  expect(fmt.joinMessage('PROJ-1: Fix fee', ' ')).toBe('PROJ-1: Fix fee')
})
