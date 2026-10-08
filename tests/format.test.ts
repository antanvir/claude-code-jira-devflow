import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/constants'
import * as fmt from '../hooks/format'

test('usage bars switch colour at 60% and 85%', async () => {
  expect(fmt.levelColor(42)).toBe('success')
  expect(fmt.levelColor(60)).toBe('warning')
  expect(fmt.levelColor(85)).toBe('error')
  expect(fmt.bar(50)).toBe('█████░░░░░')
})

test('on-demand meter falls back to session cost against the budget', async () => {
  const snapshot = fmt.toUsageSnapshot(
    {
      startedAt: 0,
      context: { window: 200_000, percent: 61 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 42 }],
      cost: { usd: 18.2 },
    },
    20,
  )
  expect(snapshot.fiveHour?.percent).toBe(42)
  expect(snapshot.onDemand?.percent).toBe(91)
  expect(snapshot.context?.label).toBe('61%')
  expect(snapshot.weekly).toBe(undefined)
})

test('commit messages lose attribution lines', async () => {
  const message = fmt.stripAttribution('PBN-1: Fix fee\n\nCo-Authored-By: Claude <noreply@anthropic.com>')
  expect(message).toBe('PBN-1: Fix fee')
})

test('only touched files git still lists are kept', async () => {
  const files = ['C:\\repo\\src\\a.ts', 'C:\\repo\\src\\b.ts']
  expect(fmt.filterDirty(files, ' M src/a.ts\n')).toEqual(['C:\\repo\\src\\a.ts'])
})

test('plan copies are named <TICKET>-<name>.md beside the original', async () => {
  const path = 'C:\\Users\\me\\.claude\\plans\\sleepy-otter.md'
  expect(fmt.namedPlanPath(path, 'PBN-1234', fmt.slugify('Refund Fee Fix!'))).toBe(
    'C:\\Users\\me\\.claude\\plans/PBN-1234-refund-fee-fix.md',
  )
  expect(fmt.headingSlug('# Plan: Fix refund double count\n...')).toBe('fix-refund-double-count')
})

test('update prompt includes only the enabled parts', async () => {
  const prompt = fmt.updateTicketPrompt('PBN-1', { ...DEFAULT_CONFIG, email: 'a@b.c', updateParts: ['labels'] })
  expect(prompt.includes('append labels "Enosis", "pbn"')).toBe(true)
  expect(prompt.includes('status')).toBe(false)
})
