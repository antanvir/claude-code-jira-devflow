// Pure helpers: no `$` here (the engine only follows `$` within register.tsx).
import type { SessionUsage } from 'claude-code'

import type { DevflowConfig, Meter, UsageSnapshot } from '../types'
import { DANGER_PERCENT, GLOBAL_CONFIG_FIELDS, MAX_DIFF_CHARS, PLUGIN, WARN_PERCENT } from './constants'

const UUID_RE = /"(?:id|cloudId)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i
const GIT_RULES_RE = /##\s*Git Commits?[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i

const round = (n: number) => Math.round(n * 10) / 10

export const toOptions = (values: readonly string[]) => values.map(value => ({ value }))

export const parseLabels = (text: string) => text.split(',').map(label => label.trim()).filter(Boolean)
export const labelsText = (labels: readonly string[]) => labels.join(', ')

// Commit messages are subject + optional one-line body (2-line rule); inputs are single-line.
export function splitMessage(message: string): { subject: string; body: string } {
  const [subject = '', ...rest] = message.split('\n').map(line => line.trim()).filter(Boolean)
  return { subject, body: rest.join(' ') }
}

export const joinMessage = (subject: string, body: string) => [subject.trim(), body.trim()].filter(Boolean).join('\n')

export function splitConfig(config: Partial<DevflowConfig>) {
  const user: Partial<DevflowConfig> = {}
  const repo: Partial<DevflowConfig> = { ...config }
  for (const field of GLOBAL_CONFIG_FIELDS) {
    if (field in repo) Object.assign(user, { [field]: repo[field] })
    delete repo[field]
  }
  return { user, repo }
}

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

export function toUsageSnapshot(usage: SessionUsage): UsageSnapshot {
  const meter = (kind: string): Meter | undefined => {
    const found = usage.rateLimits.find(r => r.kind === kind)
    if (!found) return undefined
    return { percent: found.percentUsed, label: `${found.percentUsed}% ${resetLabel(found.resetsAt)}`.trim() }
  }
  const ctx = usage.context.percent
  return {
    fiveHour: meter('five_hour'),
    weekly: meter('seven_day'),
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

// --- workflow --------------------------------------------------------------

export type Transition = { id: string; name: string; to: string; category: string }
export type IssueStatus = { status: string; category: string }

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export const projectKey = (ticket: string) => ticket.split('-')[0] ?? ticket

// Connector replies are JSON, sometimes wrapped in prose; null when none parses.
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null
const str = (value: unknown) => (typeof value === 'string' ? value : '')

// Depth-first visit of every object, so reply nesting can vary.
function walk(value: unknown, visit: (node: Json) => void): void {
  if (Array.isArray(value)) value.forEach(item => walk(item, visit))
  else if (isObject(value)) {
    visit(value)
    Object.values(value).forEach(item => walk(item, visit))
  }
}

const toStatus = (value: unknown): IssueStatus | undefined => {
  if (!isObject(value) || !str(value.name)) return undefined
  const category = isObject(value.statusCategory) ? str(value.statusCategory.key) : ''
  return { status: str(value.name), category }
}

export function parseTransitions(text: string): Transition[] {
  const found: Transition[] = []
  walk(parseJson(text), node => {
    if (!Array.isArray(node.transitions)) return
    for (const t of node.transitions) {
      const to = isObject(t) ? toStatus(t.to) : undefined
      if (isObject(t) && to) found.push({ id: String(t.id), name: str(t.name), to: to.status, category: to.category })
    }
  })
  return found
}

export function parseIssueStatus(text: string): IssueStatus | undefined {
  let found: IssueStatus | undefined
  walk(parseJson(text), node => {
    if (!found && isObject(node.fields)) found = toStatus(node.fields.status)
  })
  return found
}

// Distinct status names across a JQL search reply.
export function parseStatusNames(text: string): string[] {
  const names = new Set<string>()
  walk(parseJson(text), node => {
    const status = isObject(node.fields) ? toStatus(node.fields.status) : undefined
    if (status) names.add(status.status)
  })
  return [...names]
}

// Status moves in an issue changelog are transitions the workflow allows.
export function parseChangelogEdges(text: string): Array<[string, string]> {
  const edges: Array<[string, string]> = []
  walk(parseJson(text), node => {
    if (node.field === 'status' && str(node.fromString) && str(node.toString)) {
      edges.push([str(node.fromString), str(node.toString)])
    }
  })
  return edges
}

export function addEdges(edges: Record<string, string[]>, from: string, tos: readonly string[]): Record<string, string[]> {
  const known = edges[from] ?? []
  const added = tos.filter(to => !same(to, from) && !known.some(k => same(k, to)))
  return added.length > 0 ? { ...edges, [from]: [...known, ...added] } : edges
}

export function mergeStatuses(known: readonly string[], found: readonly string[]): string[] {
  return [...known, ...found.filter(name => !known.some(k => same(k, name)))]
}

// Shortest known route (BFS); [] when the target is not reachable on what was learned.
export function findPath(edges: Record<string, string[]>, from: string, to: string): string[] {
  const prev = new Map<string, string>([[from.toLowerCase(), '']])
  const names = new Map<string, string>([[from.toLowerCase(), from]])
  const queue = [from]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (same(current, to)) {
      const path: string[] = []
      for (let key = current.toLowerCase(); key !== from.toLowerCase(); key = prev.get(key) as string) {
        path.unshift(names.get(key) as string)
      }
      return path
    }
    const out = Object.entries(edges).find(([name]) => same(name, current))?.[1] ?? []
    for (const next of out) {
      if (prev.has(next.toLowerCase())) continue
      prev.set(next.toLowerCase(), current.toLowerCase())
      names.set(next.toLowerCase(), next)
      queue.push(next)
    }
  }
  return []
}

// Unexplored hops: in-progress first, done last (closing often blocks further moves).
const EXPLORE_RANK: Record<string, number> = { indeterminate: 0, new: 1, done: 2 }

// Next hop toward `target`: direct, else the shortest learned route, else explore an
// unvisited status. undefined when every option was already visited.
export function pickTransition(
  available: readonly Transition[],
  edges: Record<string, string[]>,
  target: string,
  visited: readonly string[],
): Transition | undefined {
  const direct = available.find(t => same(t.to, target))
  if (direct) return direct
  const fresh = available.filter(t => !visited.some(v => same(v, t.to)))
  const routed = fresh
    .map(t => ({ t, length: findPath(edges, t.to, target).length }))
    .filter(r => r.length > 0)
    .sort((a, b) => a.length - b.length)[0]
  if (routed) return routed.t
  const rank = (t: Transition) => EXPLORE_RANK[t.category] ?? 1
  return [...fresh].sort((a, b) => rank(a) - rank(b))[0]
}

// Project statuses when known, keeping the saved choice selectable.
export function statusOptions(project: readonly string[], saved: string, fallback: readonly string[]): string[] {
  const base = project.length > 0 ? project : fallback
  return saved && !base.some(name => same(name, saved)) ? [saved, ...base] : [...base]
}

export function statusLabel(statuses: { project: string; isLoading: boolean } | null): string {
  if (!statuses) return 'Status'
  return `Status (${statuses.project}${statuses.isLoading ? ', loading…' : ''})`
}

// Parts still needing the skill once status is handled by the mod.
export function hasSkillParts(config: DevflowConfig): boolean {
  return config.updateParts.includes('developedBy') || (config.updateParts.includes('labels') && config.labels.length > 0)
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
