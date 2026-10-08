// Pure helpers: no `$` here (the engine only follows `$` within register.tsx).
import type { SessionUsage } from 'claude-code'

import type { DevflowConfig, Meter, UsageSnapshot } from '../types'
import { DANGER_PERCENT, MAX_DIFF_CHARS, PLUGIN, WARN_PERCENT } from './constants'

const UUID_RE = /"(?:id|cloudId)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i
const GIT_RULES_RE = /##\s*Git Commits?[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i

const round = (n: number) => Math.round(n * 10) / 10

export const toOptions = (values: readonly string[]) => values.map(value => ({ value }))

export function parseCloudId(text: string): string | undefined {
  return UUID_RE.exec(text)?.[1]
}

export function gitRulesSection(claudeMd: string): string {
  return GIT_RULES_RE.exec(claudeMd)?.[1]?.trim() ?? ''
}

// --- usage -----------------------------------------------------------------

function resetLabel(resetsAt?: string): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - Date.now()
  if (!(ms > 0)) return ''
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 24) return `↻${Math.floor(hours / 24)}d`
  return `↻${hours}h${Math.floor((ms % 3_600_000) / 60_000)}m`
}

export function toUsageSnapshot(usage: SessionUsage, budgetUsd: number): UsageSnapshot {
  const limit = (kind: string) => usage.rateLimits.find(r => r.kind === kind)
  const meter = (kind: string): Meter | undefined => {
    const found = limit(kind)
    if (!found) return undefined
    return { percent: found.percentUsed, label: `${found.percentUsed}% ${resetLabel(found.resetsAt)}`.trim() }
  }
  const spend = limit('spend_limit')
  const usd = usage.cost?.usd
  let onDemand: Meter | undefined
  if (spend) onDemand = { percent: spend.percentUsed, label: `${spend.percentUsed}%` }
  else if (usd !== undefined && budgetUsd > 0) {
    onDemand = { percent: round((usd / budgetUsd) * 100), label: `$${usd.toFixed(2)}/$${budgetUsd}` }
  }
  const ctx = usage.context.percent
  return {
    fiveHour: meter('five_hour'),
    weekly: meter('seven_day'),
    onDemand,
    context: ctx === undefined ? undefined : { percent: round(ctx), label: `${round(ctx)}%` },
  }
}

export function levelColor(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= DANGER_PERCENT) return 'error'
  if (percent >= WARN_PERCENT) return 'warning'
  return 'success'
}

export function bar(percent: number, cells = 10): string {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

// --- git -------------------------------------------------------------------

const normalize = (path: string) => path.replace(/\\/g, '/')

// Keeps the touched files that `git status --porcelain` still lists.
export function filterDirty(files: string[], porcelain: string): string[] {
  const dirty = porcelain.split('\n').filter(Boolean).map(line => normalize(line.slice(3)))
  return files.filter(file => dirty.some(path => normalize(file).endsWith(path)))
}

export type DirtyEntry = { path: string; isDeleted: boolean }

// Parses `git status --porcelain -z`; a rename/copy is followed by its source path.
export function parsePorcelainZ(output: string): DirtyEntry[] {
  const parts = output.split('\0')
  const entries: DirtyEntry[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ''
    if (part.length < 4) continue
    const code = part.slice(0, 2)
    entries.push({ path: part.slice(3), isDeleted: code.includes('D') })
    if (/[RC]/.test(code)) i++
  }
  return entries
}

// Files dirty now whose content differs from (or was clean at) the baseline.
export function changedSince(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after).filter(path => before[path] !== after[path])
}

export function stripAttribution(message: string): string {
  return message
    .replace(/(^```\w*\n?)|(```$)/g, '')
    .split('\n')
    .filter(line => !/^\s*co-authored-by:/i.test(line) && !/generated with/i.test(line))
    .join('\n')
    .trim()
}

export function commitMessagePrompt(ticket: string | null, rules: string, status: string, diff: string): string {
  return [
    'Write a git commit message for this change. Output only the message.',
    'Rules: max 2 lines, precise subject stating what changed, no filler, no Co-Authored-By, no tool attribution.',
    ticket ? `Prefix the subject with "${ticket}: ".` : '',
    rules ? `Project rules:\n${rules}` : '',
    `Files:\n${status}`,
    `Diff:\n${diff.slice(0, MAX_DIFF_CHARS)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function fallbackMessage(ticket: string | null, count: number): string {
  const subject = `Update ${count} file${count === 1 ? '' : 's'}`
  return ticket ? `${ticket}: ${subject}` : subject
}

// --- plan ------------------------------------------------------------------

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+)|(-+$)/g, '')
    .split('-')
    .slice(0, 7)
    .join('-')
}

export function planNamePrompt(plan: string): string {
  return `Give a concise 3-6 word kebab-case file name (no extension, no ticket key) for this plan. Output only the name.\n\n${plan.slice(0, 4000)}`
}

export function headingSlug(plan: string): string {
  const heading = /^#+\s*(.+)$/m.exec(plan)?.[1] ?? 'plan'
  return slugify(heading.replace(/^plan:?\s*/i, '')) || 'plan'
}

export function namedPlanPath(path: string, ticket: string | null, name: string): string {
  const dir = path.replace(/[\\/][^\\/]+$/, '')
  const prefix = ticket ? ticket + '-' : ''
  return `${dir}/${prefix}${name}.md`
}

// --- prompts the mod submits ----------------------------------------------

// Status/field/label changes vary per Jira project, so the model does them through
// the skills bundled in skills/. Plugin-namespaced so a user's own same-named skill
// (often hardcoded to its owner) never runs from the panel.
const UPDATE_SKILL = `${PLUGIN}:update-jira-ticket`
const AC_SKILL = `${PLUGIN}:write-acceptance-criteria`

export function updateTicketPrompt(ticket: string, config: DevflowConfig): string {
  const asks: string[] = []
  if (config.updateParts.includes('status')) asks.push(`status → "${config.status}"`)
  if (config.updateParts.includes('developedBy')) asks.push(`"Developed by" → ${config.developedBy || config.email}`)
  if (config.updateParts.includes('labels') && config.labels.length > 0) {
    const labels = config.labels.map(label => JSON.stringify(label)).join(', ')
    asks.push(`append labels ${labels} (keep existing labels)`)
  }
  return `Use the ${UPDATE_SKILL} skill on ${ticket}: ${asks.join('; ')}. Jira user email: ${config.email}. Report what changed in one line.`
}

export function writeAcPrompt(ticket: string): string {
  return `Use the ${AC_SKILL} skill for ${ticket} based on this session's work.`
}

export function reviewPrompt(model: string, effort: string, base: string): string {
  return [
    `Spawn an Agent with model "${model}" and effort "${effort}" to review the pushed changes`,
    `(\`git diff ${base}...HEAD\`) for correctness bugs, ranked by severity.`,
    'Relay its findings; do not edit files.',
  ].join(' ')
}
