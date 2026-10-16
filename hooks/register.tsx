// jira-devflow: every function that touches `$` lives in this file,
// because the engine follows `$` only into functions declared in the same file.
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type {
  CommitCard,
  DevflowConfig,
  DraftField,
  Drafts,
  Findings,
  Meter,
  PaneSection,
  PlanInfo,
  ProjectStatuses,
  ReviewChoice,
  SaveRevs,
  TurnBaseline,
  UpdatePart,
  UsageSnapshot,
  Workflow,
} from '../types'
import {
  ATLASSIAN_PREFIX,
  COMMAND,
  CONNECTORS_URL,
  DEFAULT_CONFIG,
  BAND_NARROW_COLUMNS,
  BAR_CELLS,
  BAR_CELLS_NARROW,
  COMPACT_ICON,
  EDIT_TOOL_RE,
  GIT_TIMEOUT_MS,
  GROUP_BORDER,
  GROUP_BORDER_HOVER,
  JIRA_COLOR,
  MAX_TRANSITION_STEPS,
  MIN_FINDINGS_CHARS,
  PANE_EXPAND_ICON,
  PANE_ID,
  PANE_MINIMIZE_ICON,
  PANE_TITLE,
  PLAN_FILE_RE,
  PUSH_TIMEOUT_MS,
  REVIEW_EFFORTS,
  REVIEW_MODELS,
  STATUS_OPTIONS,
  STATUS_SAMPLE_SIZE,
  STORE_CLOUD_ID,
  STORE_CONFIG,
  STORE_REPO_CONFIG_PREFIX,
  STORE_WORKFLOW_PREFIX,
  TICKET_RE,
  USAGE_REFRESH_MS,
  UTILITY_MODEL,
} from './constants'
import * as fmt from './format'

type Outcome = { isOk: boolean; text: string }
type GitStep = 'stage' | 'commit' | 'push'

const IDLE_COMMIT: CommitCard = { files: [], message: '', phase: 'idle' }

// --- session state -------------------------------------------------------------
// One literal ref + accessor pair per key: `claude plugin validate` must see each
// `plugin`/`key` literal at its $.state call, so refs are never passed around.

const TICKET = { plugin: 'jira-devflow', key: 'ticket' } as const
const STATUSES = { plugin: 'jira-devflow', key: 'statuses' } as const
const CONFIG = { plugin: 'jira-devflow', key: 'config' } as const
const USAGE = { plugin: 'jira-devflow', key: 'usage' } as const
const COMMIT = { plugin: 'jira-devflow', key: 'commit' } as const
const FINDINGS = { plugin: 'jira-devflow', key: 'findings' } as const
const PLAN = { plugin: 'jira-devflow', key: 'plan' } as const
const REVIEW = { plugin: 'jira-devflow', key: 'review' } as const
const OPEN = { plugin: 'jira-devflow', key: 'open' } as const
const DRAFTS = { plugin: 'jira-devflow', key: 'drafts' } as const
const REVS = { plugin: 'jira-devflow', key: 'revs' } as const
const NOTICE = { plugin: 'jira-devflow', key: 'notice' } as const
const BASELINE = { plugin: 'jira-devflow', key: 'baseline' } as const
const PANE_CLOSED = { plugin: 'jira-devflow', key: 'paneClosed' } as const

const getTicket = async ($: EngineInterface) => (await $.state.get(TICKET)).value ?? null
const getStatuses = async ($: EngineInterface) => (await $.state.get(STATUSES)).value ?? null
const setStatuses = ($: EngineInterface, value: ProjectStatuses | null) => $.state.set(STATUSES, value)
const getConfig = async ($: EngineInterface) => (await $.state.get(CONFIG)).value ?? DEFAULT_CONFIG
const setConfig = ($: EngineInterface, value: DevflowConfig) => $.state.set(CONFIG, value)
const getUsage = async ($: EngineInterface) => (await $.state.get(USAGE)).value ?? {}
const setUsage = ($: EngineInterface, value: UsageSnapshot) => $.state.set(USAGE, value)
const getCommit = async ($: EngineInterface) => (await $.state.get(COMMIT)).value ?? IDLE_COMMIT
const setCommit = ($: EngineInterface, value: CommitCard) => $.state.set(COMMIT, value)
const getFindings = async ($: EngineInterface) => (await $.state.get(FINDINGS)).value ?? null
const setFindings = ($: EngineInterface, value: Findings | null) => $.state.set(FINDINGS, value)
const getPlan = async ($: EngineInterface) => (await $.state.get(PLAN)).value ?? { postToJira: false }
const setPlan = ($: EngineInterface, value: PlanInfo) => $.state.set(PLAN, value)
const getReview = async ($: EngineInterface) => (await $.state.get(REVIEW)).value ?? { model: 'opus', effort: 'medium' }
const setReview = ($: EngineInterface, value: ReviewChoice) => $.state.set(REVIEW, value)
const getOpen = async ($: EngineInterface) => (await $.state.get(OPEN)).value ?? []
const setOpen = ($: EngineInterface, value: PaneSection[]) => $.state.set(OPEN, value)
const getDrafts = async ($: EngineInterface) => (await $.state.get(DRAFTS)).value ?? {}
const setDrafts = ($: EngineInterface, value: Drafts) => $.state.set(DRAFTS, value)
const getRevs = async ($: EngineInterface) => (await $.state.get(REVS)).value ?? {}
const setRevs = ($: EngineInterface, value: SaveRevs) => $.state.set(REVS, value)
const getNotice = async ($: EngineInterface) => (await $.state.get(NOTICE)).value ?? null
const getBaseline = async ($: EngineInterface) => (await $.state.get(BASELINE)).value ?? null
const setBaseline = ($: EngineInterface, value: TurnBaseline | null) => $.state.set(BASELINE, value)
const getPaneClosed = async ($: EngineInterface) => (await $.state.get(PANE_CLOSED)).value ?? false

async function setTicket($: EngineInterface, value: string | null): Promise<void> {
  const previous = await getTicket($)
  await $.state.set(TICKET, value)
  if (value && value !== previous) void loadStatuses($, value)
}

async function notify($: EngineInterface, text: string | null): Promise<void> {
  await $.state.set(NOTICE, text)
}

async function setSection($: EngineInterface, section: PaneSection, isOpen: boolean): Promise<void> {
  const open = (await getOpen($)).filter(s => s !== section)
  await setOpen($, isOpen ? [...open, section] : open)
}

async function toggleSection($: EngineInterface, section: PaneSection): Promise<void> {
  await setSection($, section, !(await getOpen($)).includes(section))
}

async function setDraft($: EngineInterface, field: DraftField, value: string): Promise<void> {
  await setDrafts($, { ...(await getDrafts($)), [field]: value })
}

// Writes typed-but-unsaved values (all, or one field) so nothing typed is lost.
async function commitDrafts($: EngineInterface, only?: DraftField): Promise<void> {
  const drafts = await getDrafts($)
  const fields = (Object.keys(drafts) as DraftField[]).filter(f => !only || f === only)
  const patch: Partial<DevflowConfig> = {}
  if (fields.includes('subject') || fields.includes('body')) {
    const saved = fmt.splitMessage((await getCommit($)).message)
    await patchCommit($, { message: fmt.joinMessage(drafts.subject ?? saved.subject, drafts.body ?? saved.body) })
  }
  for (const field of fields) {
    const value = drafts[field] ?? ''
    if (field === 'labels') patch.labels = fmt.parseLabels(value)
    else if (field === 'email' || field === 'developedBy') patch[field] = value.trim()
  }
  if (Object.keys(patch).length > 0) await saveConfig($, patch)
  const rest = { ...drafts }
  for (const field of fields) delete rest[field]
  await setDrafts($, rest)
  // The host empties a field on Enter and skips redrawing an unchanged value; a new key forces it.
  const revs = await getRevs($)
  await setRevs($, { ...revs, ...Object.fromEntries(fields.map(f => [f, (revs[f] ?? 0) + 1])) })
}

// Surfaces that place no panes (VS Code) answer isPlaced: false; the band stands in.
async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
  await $.state.set(PANE_CLOSED, false)
  return opened.isPlaced
}

// Reopening after a close (or a minimize) always shows the full pane.
async function showPane($: EngineInterface): Promise<boolean> {
  await setSection($, 'minimized', false)
  return openPane($)
}

const isPaneUp = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PANE_ID && pane.isPlaced)

async function patchCommit($: EngineInterface, patch: Partial<CommitCard>): Promise<void> {
  await setCommit($, { ...(await getCommit($)), ...patch })
}

async function patchPlan($: EngineInterface, patch: Partial<PlanInfo>): Promise<void> {
  await setPlan($, { ...(await getPlan($)), ...patch })
}

async function patchReview($: EngineInterface, patch: Partial<ReviewChoice>): Promise<void> {
  await setReview($, { ...(await getReview($)), ...patch })
}

async function saveConfig($: EngineInterface, patch: Partial<DevflowConfig>): Promise<void> {
  const next = { ...(await getConfig($)), ...patch }
  await setConfig($, next)
  const { user, repo } = fmt.splitConfig(next)
  const global = (await $.store.get(STORE_CONFIG)) as Partial<DevflowConfig> | undefined
  await $.store.set(STORE_CONFIG, { ...global, ...user })
  await $.store.set(await repoConfigKey($), repo)
}

// Keyed by repo root so subdirectory sessions share it; cwd outside a git repo.
async function repoConfigKey($: EngineInterface): Promise<string> {
  const root = await git($, ['rev-parse', '--show-toplevel'])
  return STORE_REPO_CONFIG_PREFIX + (root.isOk ? root.text : await $.session.cwd())
}

async function loadConfig($: EngineInterface): Promise<DevflowConfig> {
  const repo = (await $.store.get(await repoConfigKey($))) as Partial<DevflowConfig> | undefined
  const global = (await $.store.get(STORE_CONFIG)) as Partial<DevflowConfig> | undefined
  const { user } = fmt.splitConfig(global ?? {})
  return { ...DEFAULT_CONFIG, ...(repo ? fmt.splitConfig(repo).repo : global), ...user }
}

async function refreshUsage($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  await setUsage($, fmt.toUsageSnapshot(usage))
}

async function compact($: EngineInterface): Promise<void> {
  await notify($, 'Compacting context…')
  await $.session.compact()
  await refreshUsage($)
  await notify($, 'Context compacted')
}

// --- Jira ------------------------------------------------------------------

async function callAtlassian($: EngineInterface, name: string, input: object): Promise<Outcome> {
  try {
    const ran = await $.tool.call({ tool: `${ATLASSIAN_PREFIX}${name}`, ...input } as never)
    if (ran.deny !== undefined) return { isOk: false, text: ran.deny }
    return { isOk: ran.isError !== true, text: String(ran.text ?? '') }
  } catch (error) {
    // Rejects when the connector is not connected (no such tool).
    return { isOk: false, text: String(error) }
  }
}

async function isConnectorAvailable($: EngineInterface): Promise<boolean> {
  const tools = await $.tool.list()
  return tools.some(tool => tool.name.startsWith(ATLASSIAN_PREFIX))
}

async function cloudId($: EngineInterface): Promise<string | undefined> {
  const cached = await $.store.get(STORE_CLOUD_ID)
  if (typeof cached === 'string') return cached
  const found = await callAtlassian($, 'getAccessibleAtlassianResources', {})
  const id = fmt.parseCloudId(found.text)
  if (id) await $.store.set(STORE_CLOUD_ID, id)
  return id
}

async function addComment($: EngineInterface, ticket: string, markdown: string): Promise<Outcome> {
  const id = await cloudId($)
  if (!id) return { isOk: false, text: 'No Atlassian site found' }
  return callAtlassian($, 'addCommentToJiraIssue', {
    cloudId: id,
    issueIdOrKey: ticket,
    commentBody: markdown,
    contentFormat: 'markdown',
  })
}

// --- workflow (status dropdown + multi-step transitions) ---------------------

async function getWorkflow($: EngineInterface, project: string): Promise<Workflow> {
  const saved = (await $.store.get(STORE_WORKFLOW_PREFIX + project)) as Workflow | undefined
  return saved ?? { statuses: [], edges: {} }
}

async function saveWorkflow($: EngineInterface, project: string, workflow: Workflow): Promise<void> {
  await $.store.set(STORE_WORKFLOW_PREFIX + project, workflow)
}

async function showStatuses($: EngineInterface, project: string, statuses: string[], isLoading: boolean): Promise<void> {
  const ticket = await getTicket($)
  if (ticket && fmt.projectKey(ticket) === project) await setStatuses($, { project, statuses, isLoading })
}

// Cached list shows at once; refreshed from recent project issues, the ticket's
// transitions and its changelog (which also teaches the workflow edges).
async function loadStatuses($: EngineInterface, ticket: string): Promise<void> {
  const project = fmt.projectKey(ticket)
  const cached = await getWorkflow($, project)
  await showStatuses($, project, cached.statuses, true)
  const id = await cloudId($)
  if (!id) return showStatuses($, project, cached.statuses, false)
  const [search, issue, transitions] = await Promise.all([
    callAtlassian($, 'searchJiraIssuesUsingJql', {
      cloudId: id,
      jql: `project = "${project}" ORDER BY updated DESC`,
      fields: ['status'],
      maxResults: STATUS_SAMPLE_SIZE,
    }),
    callAtlassian($, 'getJiraIssue', { cloudId: id, issueIdOrKey: ticket, fields: ['status'], expand: 'changelog' }),
    callAtlassian($, 'getTransitionsForJiraIssue', { cloudId: id, issueIdOrKey: ticket }),
  ])
  const current = issue.isOk ? fmt.parseIssueStatus(issue.text) : undefined
  const targets = transitions.isOk ? fmt.parseTransitions(transitions.text).map(t => t.to) : []
  let workflow = await getWorkflow($, project)
  for (const [from, to] of issue.isOk ? fmt.parseChangelogEdges(issue.text) : []) {
    workflow = { ...workflow, edges: fmt.addEdges(workflow.edges, from, [to]) }
  }
  if (current) workflow = { ...workflow, edges: fmt.addEdges(workflow.edges, current.status, targets) }
  const found = [...(search.isOk ? fmt.parseStatusNames(search.text) : []), ...(current ? [current.status] : []), ...targets]
  workflow = { ...workflow, statuses: fmt.mergeStatuses(workflow.statuses, found) }
  await saveWorkflow($, project, workflow)
  await showStatuses($, project, workflow.statuses, false)
}

// Walks transitions one at a time until the ticket reaches `target`, learning edges
// as it goes; Jira only exposes the transitions out of the current status.
async function moveToStatus($: EngineInterface, ticket: string, target: string): Promise<Outcome> {
  const id = await cloudId($)
  if (!id) return { isOk: false, text: 'No Atlassian site found' }
  const project = fmt.projectKey(ticket)
  const issue = await callAtlassian($, 'getJiraIssue', { cloudId: id, issueIdOrKey: ticket, fields: ['status'] })
  let current = issue.isOk ? fmt.parseIssueStatus(issue.text) : undefined
  if (!current) return { isOk: false, text: issue.isOk ? `${ticket}: status unreadable` : issue.text }
  const start = current.status
  if (current.status.toLowerCase() === target.toLowerCase()) return { isOk: true, text: `${ticket} already in ${target}` }
  const visited = [current.status]
  let workflow = await getWorkflow($, project)
  for (let step = 0; step < MAX_TRANSITION_STEPS; step++) {
    const listed = await callAtlassian($, 'getTransitionsForJiraIssue', { cloudId: id, issueIdOrKey: ticket })
    if (!listed.isOk) return { isOk: false, text: listed.text }
    const available = fmt.parseTransitions(listed.text)
    workflow = { ...workflow, edges: fmt.addEdges(workflow.edges, current.status, available.map(t => t.to)) }
    await saveWorkflow($, project, workflow)
    const next = fmt.pickTransition(available, workflow.edges, target, visited)
    if (!next) break
    await notify($, `${ticket}: ${current.status} → ${next.to}…`)
    const moved = await callAtlassian($, 'transitionJiraIssue', { cloudId: id, issueIdOrKey: ticket, transition: { id: next.id } })
    if (!moved.isOk) return { isOk: false, text: `${ticket}: ${current.status} → ${next.to} failed: ${moved.text}` }
    current = { status: next.to, category: next.category }
    visited.push(next.to)
    if (next.to.toLowerCase() === target.toLowerCase()) return { isOk: true, text: `${ticket}: ${visited.join(' → ')}` }
  }
  const moved = visited.length > 1 ? ` (moved ${visited.join(' → ')})` : ''
  return { isOk: false, text: `${ticket}: no route from ${start} to ${target} found${moved}` }
}

async function verifyConnector($: EngineInterface): Promise<void> {
  const config = await getConfig($)
  if (!(await isConnectorAvailable($))) {
    await notify($, 'Atlassian connector not connected: authorise it in claude.ai connector settings')
    return
  }
  const info = await callAtlassian($, 'atlassianUserInfo', {})
  const matches = info.isOk && info.text.toLowerCase().includes(config.email.toLowerCase())
  if (matches) {
    await notify($, `Jira connected as ${config.email}`)
    await setSection($, 'settings', false)
  } else {
    await notify($, info.isOk ? 'Connected, but as a different email' : info.text)
  }
}

// Jira actions need the user's email first (asked once, then kept in $.store).
async function requireTicket($: EngineInterface): Promise<{ ticket: string; config: DevflowConfig } | null> {
  const config = await getConfig($)
  if (!config.email) {
    await setSection($, 'settings', true)
    await notify($, 'Set your Jira email in Settings first')
    return null
  }
  const ticket = await getTicket($)
  if (!ticket) {
    await notify($, 'No ticket yet: mention one (e.g. PROJ-1234) in a prompt or set it in the panel')
    return null
  }
  return { ticket, config }
}

// Status runs here (deterministic, multi-step); other fields go through the skill.
async function updateTicket($: EngineInterface): Promise<void> {
  await commitDrafts($)
  const ready = await requireTicket($)
  if (!ready) return
  await setSection($, 'update', false)
  const { ticket, config } = ready
  if (config.updateParts.includes('status')) {
    const moved = await moveToStatus($, ticket, config.status)
    await notify($, moved.text)
    void loadStatuses($, ticket)
  }
  const rest = { ...config, updateParts: config.updateParts.filter(part => part !== 'status') }
  if (fmt.hasSkillParts(rest)) void $.prompt.submit({ text: fmt.updateTicketPrompt(ticket, rest) })
}

async function writeAc($: EngineInterface): Promise<void> {
  const ready = await requireTicket($)
  if (!ready) return
  void $.prompt.submit({ text: fmt.writeAcPrompt(ready.ticket) })
}

async function shareFindings($: EngineInterface): Promise<void> {
  const findings = await getFindings($)
  if (!findings) return
  await notify($, `Posting findings to ${findings.ticket}…`)
  const posted = await addComment($, findings.ticket, findings.text)
  if (posted.isOk) await setFindings($, { ...findings, isShared: true })
  await notify($, posted.isOk ? `Comment added to ${findings.ticket}` : `Jira comment failed: ${posted.text}`)
}

// --- git -------------------------------------------------------------------

async function git($: EngineInterface, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<Outcome> {
  const ran = await $.process.run(['git', ...args], { timeoutMs })
  const isOk = ran.exitCode === 0
  // trimEnd: porcelain lines start with a meaningful space (" M path").
  return { isOk, text: (isOk ? ran.stdout : ran.stderr || ran.stdout).trimEnd() }
}

// Content hash of every dirty file, so a turn's edits are found however they were
// made (Edit, Write, Bash, scripts) and survive a reload of this module.
async function dirtySnapshot($: EngineInterface): Promise<Record<string, string>> {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (!top.isOk) return {}
  const root = top.text.trim()
  const status = await git($, ['-C', root, 'status', '--porcelain', '-z', '-uall'])
  if (!status.isOk) return {}
  const entries = fmt.parsePorcelainZ(status.text)
  const present = entries.filter(entry => !entry.isDeleted).map(entry => entry.path)
  const hashed = present.length
    ? await $.process.run(['git', '-C', root, 'hash-object', '--stdin-paths'], {
        stdin: present.join('\n') + '\n',
        timeoutMs: GIT_TIMEOUT_MS,
      })
    : undefined
  const hashes = hashed?.exitCode === 0 ? hashed.stdout.trim().split('\n') : []
  const snapshot: Record<string, string> = {}
  for (const entry of entries) {
    snapshot[`${root}/${entry.path}`] = entry.isDeleted ? 'deleted' : (hashes[present.indexOf(entry.path)] ?? '?')
  }
  return snapshot
}

async function pendingFiles($: EngineInterface, files: string[]): Promise<string[]> {
  if (files.length === 0) return []
  const status = await git($, ['status', '--porcelain', '--', ...files])
  return status.isOk ? fmt.filterDirty(files, status.text) : []
}

async function commitRules($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const sections: string[] = []
  for (const path of [`${home}/.claude/CLAUDE.md`, 'CLAUDE.md']) {
    if (!(await $.fs.exists(path))) continue
    const rules = fmt.gitRulesSection(String(await $.fs.read(path)))
    if (rules) sections.push(rules)
  }
  return sections.join('\n')
}

async function regenerateMessage($: EngineInterface): Promise<void> {
  const card = await getCommit($)
  if (card.files.length === 0) return
  await patchCommit($, { phase: 'busy', note: 'Writing commit message…' })
  // A fresh message replaces anything typed into Subject/Body.
  const { subject: _subject, body: _body, ...otherDrafts } = await getDrafts($)
  await setDrafts($, otherDrafts)
  const ticket = await getTicket($)
  const [diff, status, rules] = [
    await git($, ['diff', 'HEAD', '--', ...card.files]),
    await git($, ['status', '--short', '--', ...card.files]),
    await commitRules($),
  ]
  const reply = await $.model.complete({
    model: UTILITY_MODEL,
    maxTokens: 200,
    prompt: fmt.commitMessagePrompt(ticket, rules, status.text, diff.text),
  })
  const message = reply.isAnswered ? fmt.stripAttribution(reply.text) : fmt.fallbackMessage(ticket, card.files.length)
  await patchCommit($, { message, phase: 'ready', note: undefined })
}

async function runGit($: EngineInterface, step: GitStep): Promise<void> {
  await commitDrafts($, 'subject')
  await commitDrafts($, 'body')
  const card = await getCommit($)
  await patchCommit($, { phase: 'busy', note: `${step}…` })
  const staged = await git($, ['add', '--', ...card.files])
  if (step === 'stage' || !staged.isOk) {
    await patchCommit($, { phase: 'ready', note: staged.isOk ? 'Staged' : staged.text })
    return
  }
  const committed = await git($, ['commit', '-m', fmt.stripAttribution(card.message), '--', ...card.files])
  if (!committed.isOk) {
    await patchCommit($, { phase: 'ready', note: committed.text })
    return
  }
  if (step === 'commit') {
    await patchCommit($, { phase: 'committed', note: committed.text.split('\n')[0] })
    return
  }
  let pushed = await git($, ['push'], PUSH_TIMEOUT_MS)
  if (!pushed.isOk && /no upstream/i.test(pushed.text)) {
    pushed = await git($, ['push', '-u', 'origin', 'HEAD'], PUSH_TIMEOUT_MS)
  }
  await patchCommit($, {
    phase: pushed.isOk ? 'pushed' : 'committed',
    note: pushed.isOk ? 'Pushed' : `Committed; push failed: ${pushed.text}`,
  })
}

async function startReview($: EngineInterface): Promise<void> {
  const choice = await getReview($)
  const head = await git($, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
  const base = head.isOk ? head.text : 'origin/main'
  void $.prompt.submit({ text: fmt.reviewPrompt(choice.model, choice.effort, base) })
}

// --- plan ------------------------------------------------------------------

// Copies the plan to "<TICKET>-<name>.md" beside it; the original stays,
// because plan mode keeps reading its own path.
// ExitPlanMode's own result names the plan file; the Write hook path is the fallback.
async function afterPlanExit($: EngineInterface, filePath?: string, planText?: string | null): Promise<void> {
  const plan = await getPlan($)
  const ticket = await getTicket($)
  const path = filePath || plan.path
  if (!path) {
    if (plan.postToJira) await notify($, 'Plan not posted: no plan file found')
    return
  }
  const text = planText || String(await $.fs.read(path))
  const reply = await $.model.complete({ model: UTILITY_MODEL, maxTokens: 30, prompt: fmt.planNamePrompt(text) })
  const name = (reply.isAnswered && fmt.slugify(reply.text)) || fmt.headingSlug(text)
  const renamedPath = fmt.namedPlanPath(path, ticket, name)
  await $.fs.write(renamedPath, text)
  await patchPlan($, { path, renamedPath })
  if (plan.postToJira) await postPlan($)
}

async function postPlan($: EngineInterface): Promise<void> {
  const plan = await getPlan($)
  const ticket = await getTicket($)
  const path = plan.renamedPath ?? plan.path
  if (!ticket) return notify($, 'Plan not posted: set a ticket first')
  if (!path) return notify($, 'No plan yet: exit plan mode first')
  await notify($, `Posting plan to ${ticket}…`)
  const posted = await addComment($, ticket, String(await $.fs.read(path)))
  await notify($, posted.isOk ? `Plan added to ${ticket}` : `Plan comment failed: ${posted.text}`)
}

// --- pane ------------------------------------------------------------------

const PART_LABELS: Record<UpdatePart, string> = {
  status: 'Status',
  developedBy: 'Developed by',
  labels: 'Append labels',
}

const check = (isOn: boolean) => (isOn ? '☑' : '☐')
const caret = (isOpen: boolean) => (isOpen ? '▾' : '▸')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const JIRA_HINT = 'Save, or it is applied with Apply to Jira'
const COMMIT_HINT = 'Save, or it is used by Stage/Commit'

async function renderPane($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const ticket = await getTicket($)
  const config = await getConfig($)
  const commit = await getCommit($)
  const findings = await getFindings($)
  const plan = await getPlan($)
  const review = await getReview($)
  const open = await getOpen($)
  const drafts = await getDrafts($)
  const revs = await getRevs($)
  const notice = await getNotice($)
  const statuses = await getStatuses($)
  const projectStatuses = ticket && statuses?.project === fmt.projectKey(ticket) ? statuses : null

  if (e.surface === 'mobile') {
    const { Text } = $.ui.resolve(e)
    return <Text>{ticket ?? 'No ticket'} · open on desktop or VSCode for actions</Text>
  }

  const { Box, Text, Button, Input, Select, Markdown } = $.ui.resolve(e)
  const isOpen = (section: PaneSection) => open.includes(section)

  // Bare Buttons only: native chrome gives equal heights, hover and the pointer cursor.
  const action = (key: string, label: string, onPress: () => Promise<unknown>, isPrimary = false) => (
    <Button key={key} label={label} variant={isPrimary ? 'primary' : 'secondary'} onPress={() => void onPress()} />
  )

  // Dashed frame per group; the keyed Box makes the frame light up on hover.
  const group = (key: string, title: string | null, children: RenderElement[]) => (
    <Box
      key={key}
      flexDirection="column"
      gap={1}
      borderStyle="dashed"
      borderColor={GROUP_BORDER}
      hover={{ borderColor: GROUP_BORDER_HOVER }}
      paddingX={1}
      paddingY={1}
    >
      {title ? <Text bold dimColor>{title}</Text> : null}
      {children}
    </Box>
  )

  const row = (key: string, children: RenderElement[]) => (
    <Box key={key} flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
      {children}
    </Box>
  )

  // Value shown = the draft while typing, else the saved one; Save/Enter or Apply commits.
  const field = (key: DraftField, label: string, saved: string, placeholder?: string, hint = JIRA_HINT) => {
    const draft = drafts[key]
    const isDirty = draft !== undefined && draft !== saved
    return (
      <Box key={`field-${key}`} flexDirection="column">
        <Input
          key={`${key}-${revs[key] ?? 0}`}
          label={label}
          placeholder={placeholder}
          value={draft ?? saved}
          submitLabel="Save"
          onInput={value => void setDraft($, key, value)}
          onSubmit={value => void setDraft($, key, value).then(() => commitDrafts($, key))}
        />
        {isDirty ? <Text color="warning">{`● unsaved — ${hint}`}</Text> : null}
      </Box>
    )
  }

  const noticeRow = notice
    ? row('notice', [
        <Text key="notice-text" color="suggestion">{notice}</Text>,
        <Button key="notice-x" label="×" plain dimColor onPress={() => void notify($, null)} />,
      ])
    : null

  // The engine owns the frame's title row and × (no API for extra marks), so the toggle heads the body.
  const isMinimized = isOpen('minimized')
  const paneHead = (
    <Box key="pane-head" flexDirection="row" justifyContent={isMinimized ? 'space-between' : 'flex-end'} alignItems="center">
      {isMinimized ? <Text key="pane-ticket" color={JIRA_COLOR} bold>{ticket ?? 'No ticket'}</Text> : null}
      <Button
        key="pane-toggle"
        label={isMinimized ? PANE_EXPAND_ICON : PANE_MINIMIZE_ICON}
        plain
        dimColor
        onPress={() => void toggleSection($, 'minimized')}
      />
    </Box>
  )
  if (isMinimized) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {paneHead}
        {noticeRow}
      </Box>
    )
  }

  const togglePart = (part: UpdatePart) =>
    saveConfig($, {
      updateParts: config.updateParts.includes(part)
        ? config.updateParts.filter(p => p !== part)
        : [...config.updateParts, part],
    })

  const updateSection = isOpen('update') ? (
    <Box key="update-body" flexDirection="column" gap={1} borderStyle="single" borderColor={GROUP_BORDER} paddingX={1} paddingY={1}>
      <Text bold>{`Apply to ${ticket ?? 'ticket'}`}</Text>
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {(Object.keys(PART_LABELS) as UpdatePart[]).map(part => (
          <Button
            key={`part-${part}`}
            label={`${check(config.updateParts.includes(part))} ${PART_LABELS[part]}`}
            plain
            onPress={() => void togglePart(part)}
          />
        ))}
      </Box>
      <Select
        key="status"
        label={fmt.statusLabel(projectStatuses)}
        options={fmt.toOptions(fmt.statusOptions(projectStatuses?.statuses ?? [], config.status, STATUS_OPTIONS))}
        value={config.status}
        onSelect={value => void saveConfig($, { status: value })}
      />
      {field('developedBy', 'Developed by', config.developedBy, config.email || 'Name or email')}
      {field('labels', 'Labels to append (comma-separated)', fmt.labelsText(config.labels), 'e.g. backend, release-notes')}
      {row('update-actions', [
        action('apply', 'Apply to Jira', () => updateTicket($), true),
        action('update-cancel', 'Cancel', () => setSection($, 'update', false)),
      ])}
    </Box>
  ) : null

  const settingsSection = isOpen('settings') ? (
    <Box key="settings-body" flexDirection="column" gap={1} borderStyle="single" borderColor={GROUP_BORDER} paddingX={1} paddingY={1}>
      <Text bold>Jira setup</Text>
      {field('email', 'Jira / Atlassian email', config.email, 'you@company.com')}
      <Markdown text={`Authorise the **Atlassian** connector in [claude.ai connector settings](${CONNECTORS_URL}), then verify.`} />
      {row('settings-actions', [
        action('verify', 'Verify connection', () => verifyConnector($)),
        action('settings-close', 'Close', () => setSection($, 'settings', false)),
      ])}
    </Box>
  ) : null

  const message = fmt.splitMessage(commit.message)
  const isAfterCommit = commit.phase === 'pushed' || commit.phase === 'committed'
  const reviewSection = isAfterCommit ? (
    <Box key="review" flexDirection="column" gap={1} borderStyle="single" borderColor={GROUP_BORDER} paddingX={1} paddingY={1}>
      <Text bold>AI Review</Text>
      {row('review-picks', [
        <Select
          key="review-model"
          label="Model"
          options={fmt.toOptions(REVIEW_MODELS)}
          value={review.model}
          onSelect={value => void patchReview($, { model: value })}
        />,
        <Select
          key="review-effort"
          label="Effort"
          options={fmt.toOptions(REVIEW_EFFORTS)}
          value={review.effort}
          onSelect={value => void patchReview($, { effort: value })}
        />,
      ])}
      {row('review-actions', [
        action('review', 'AI Review', () => startReview($), true),
        action('review-done', 'Done', () => setCommit($, IDLE_COMMIT)),
      ])}
    </Box>
  ) : null

  const commitGroup =
    commit.phase === 'idle'
      ? null
      : group('g-commit', `COMMIT · ${plural(commit.files.length, 'file')}`, [
          <Box key="commit-files" flexDirection="column">
            {commit.files.map(file => (
              <Text key={`file-${file}`} dimColor wrap="truncate-start">{file}</Text>
            ))}
          </Box>,
          <Text key="commit-message-hint" dimColor>Message (no Co-Authored-By)</Text>,
          field('subject', 'Subject', message.subject, commit.phase === 'busy' ? 'Writing…' : 'PROJ-1234: What changed', COMMIT_HINT),
          field('body', 'Body', message.body, 'Optional second line', COMMIT_HINT),
          commit.phase === 'ready'
            ? row('commit-actions', [
                action('stage', 'Stage', () => runGit($, 'stage')),
                action('commit', 'Commit', () => runGit($, 'commit'), true),
                action('push', 'Commit & Push', () => runGit($, 'push')),
                action('regen', '↻ Regenerate', () => regenerateMessage($)),
                action('dismiss', 'Dismiss', () => setCommit($, IDLE_COMMIT)),
              ])
            : null,
          commit.note ? <Text key="commit-note" dimColor>{commit.note}</Text> : null,
          reviewSection,
        ].filter(Boolean) as RenderElement[])

  const findingsGroup =
    findings && !findings.isShared
      ? group('g-findings', 'FINDINGS', [
          <Text key="findings-text">{`Findings for ${findings.ticket} ready`}</Text>,
          row('findings-actions', [
            action('share', 'Share findings in Jira', () => shareFindings($), true),
            action('findings-x', 'Dismiss', () => setFindings($, null)),
          ]),
        ])
      : null

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      {paneHead}
      {group('g-ticket', null, [
        row('ticket-head', [
          <Text key="ticket-key" color={JIRA_COLOR} bold>{ticket ?? 'No ticket'}</Text>,
          <Text key="ticket-email" dimColor>{config.email || 'Jira not set up'}</Text>,
        ]),
        <Input
          key="ticket"
          label="Ticket"
          placeholder="PROJ-1234"
          value={ticket ?? ''}
          submitLabel="Set"
          onSubmit={value => void setTicket($, value.trim().toUpperCase() || null)}
        />,
      ])}
      {group('g-jira', 'JIRA', [
        row('jira-actions', [
          action('update', `Update ticket ${caret(isOpen('update'))}`, () => toggleSection($, 'update')),
          action('ac', 'Write AC', () => writeAc($)),
          action('settings', `⚙ Settings ${caret(isOpen('settings'))}`, () => toggleSection($, 'settings')),
        ]),
        updateSection,
        settingsSection,
      ].filter(Boolean) as RenderElement[])}
      {group('g-plan', 'PLAN', [
        // Button labels never wrap, so the long caption is a Text that can shrink in a narrow pane.
        <Box key="plan-jira-row" flexDirection="row" gap={1} alignItems="flex-start">
          <Button
            key="plan-jira"
            label={check(plan.postToJira)}
            plain
            onPress={() => void patchPlan($, { postToJira: !plan.postToJira })}
          />
          <Box flexShrink={1} minWidth={0}>
            <Text>Auto-post plan as a Jira comment on exiting plan mode</Text>
          </Box>
        </Box>,
        plan.renamedPath ? <Text key="plan-path" dimColor wrap="truncate-start">{`Saved as ${plan.renamedPath}`}</Text> : null,
        plan.path ? row('plan-actions', [action('plan-post', 'Post plan to Jira', () => postPlan($))]) : null,
      ].filter(Boolean) as RenderElement[])}
      {noticeRow}
      {findingsGroup}
      {commitGroup}
    </Box>
  )
}

// --- band above the prompt --------------------------------------------------
// Usage meters always (every surface, every session); ticket/commit rows unless
// the pane is up and expanded inline above the prompt.

async function renderBand($: EngineInterface, e: RenderInput<'AbovePrompt'>): Promise<RenderElement> {
  const usage = await getUsage($)
  const canReopen = (await getPaneClosed($)) || !(await isPaneUp($))
  // An expanded inline pane already holds these cards; a docked, minimized or closed one doesn't.
  // Render hooks can't write state, so "docked" is the surface's own docks-a-pane flag.
  const isMinimized = (await getOpen($)).includes('minimized')
  const showsCards = canReopen || isMinimized || e.viewport?.isFullscreen === true
  const { Box, Text, Button } = $.ui.resolve(e)
  const isNarrow = (e.viewport?.columns ?? Infinity) < BAND_NARROW_COLUMNS
  const barCells = isNarrow ? BAR_CELLS_NARROW : BAR_CELLS

  const action = (key: string, label: string, onPress: () => Promise<unknown>, isPrimary = false) => (
    <Button key={key} label={label} variant={isPrimary ? 'primary' : 'secondary'} onPress={() => void onPress()} />
  )
  const meter = (name: string, m?: Meter) => (
    <Box key={`meter-${name}`} flexDirection="row" gap={1}>
      <Text dimColor>{name}</Text>
      {m ? (
        <Text color={fmt.levelColor(m.percent)}>{`${fmt.bar(m.percent, barCells)} ${m.label}`}</Text>
      ) : (
        <Text dimColor>n/a</Text>
      )}
    </Box>
  )
  const meters = (
    <Box key="band-meters" flexDirection="row" flexWrap="wrap" columnGap={isNarrow ? 2 : 3} alignItems="center">
      {meter('5h', usage.fiveHour)}
      {meter('Weekly', usage.weekly)}
      {meter('Context', usage.context)}
      <Box flexDirection="row" gap={1}>
        {action('band-compact', isNarrow ? COMPACT_ICON : 'Compact', () => compact($))}
        <Button key="band-refresh" label="↻" plain dimColor onPress={() => void refreshUsage($)} />
      </Box>
    </Box>
  )
  if (!showsCards) return <Box flexDirection="column" width="100%">{meters}</Box>

  const ticket = await getTicket($)
  const commit = await getCommit($)
  const findings = await getFindings($)
  const notice = await getNotice($)
  const isAfterCommit = commit.phase === 'pushed' || commit.phase === 'committed'
  // A title line over a button bar; each button grows to share the width and wraps when narrow.
  const card = (key: string, title: RenderElement, meta: string | null, buttons: RenderElement[]) => (
    <Box key={key} flexDirection="column">
      <Box flexDirection="row" gap={1} alignItems="center">
        {title}
        {meta ? <Text key="meta" dimColor wrap="truncate-end">{meta}</Text> : null}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {buttons.map((button, i) => (
          <Box key={`${key}-slot-${i}`} flexGrow={1} flexDirection="column">
            {button}
          </Box>
        ))}
      </Box>
    </Box>
  )

  let activeCard: RenderElement | null = null
  if (commit.phase === 'ready') {
    activeCard = card(
      'band-commit',
      <Text key="t" bold>{`Commit ${plural(commit.files.length, 'file')}`}</Text>,
      commit.message.split('\n')[0] || '…',
      [
        action('band-commit-go', 'Commit', () => runGit($, 'commit'), true),
        action('band-push', 'Commit & Push', () => runGit($, 'push')),
        action('band-commit-x', 'Dismiss', () => setCommit($, IDLE_COMMIT)),
      ],
    )
  } else if (isAfterCommit) {
    activeCard = card(
      'band-review',
      <Text key="t" bold>{commit.phase === 'pushed' ? 'Pushed' : 'Committed'}</Text>,
      commit.note ?? null,
      [
        action('band-review-go', 'AI Review', () => startReview($), true),
        action('band-review-x', 'Done', () => setCommit($, IDLE_COMMIT)),
      ],
    )
  } else if (findings && !findings.isShared) {
    activeCard = card('band-findings', <Text key="t" bold>{`Findings for ${findings.ticket}`}</Text>, 'ready', [
      action('band-share', 'Share in Jira', () => shareFindings($), true),
      action('band-findings-x', 'Dismiss', () => setFindings($, null)),
    ])
  }

  // GUI surfaces get a row of air between cards; terminal rows above the prompt are scarce.
  return (
    <Box flexDirection="column" width="100%" rowGap={e.surface === 'terminal' ? 0 : 1}>
      {notice ? (
        <Box key="band-notice" flexDirection="row" gap={1} alignItems="center">
          <Text color="suggestion">{notice}</Text>
          <Button key="band-notice-x" label="×" plain dimColor onPress={() => void notify($, null)} />
        </Box>
      ) : null}
      {activeCard}
      {card('band-ticket', <Text key="t" color={JIRA_COLOR} bold>{ticket ?? 'No ticket'}</Text>, null, [
        action('band-update', 'Update ticket', () => updateTicket($)),
        action('band-ac', 'Write AC', () => writeAc($)),
        ...(canReopen ? [action('band-open', 'Open panel', () => showPane($))] : []),
      ])}
      {meters}
    </Box>
  )
}

// --- hooks -----------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await setConfig($, await loadConfig($))
    const ticket = await getTicket($)
    if (ticket) void loadStatuses($, ticket)
    await $.command.register({ name: COMMAND, description: 'Open the Jira Devflow panel' })
    $.clock.every(USAGE_REFRESH_MS, () => void refreshUsage($))
    void refreshUsage($)
    void openPane($)
    return next(e)
  })

  // The person's × minimizes first; a × on the minimized pane really closes it.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    if (e.origin.kind === 'person' && !(await getOpen($)).includes('minimized')) {
      await setSection($, 'minimized', true)
      return { value: undefined }
    }
    // A state write redraws the band, which then shows its cards again.
    await $.state.set(PANE_CLOSED, true)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const isPlaced = await showPane($)
    return { text: isPlaced ? 'Jira Devflow panel opened.' : 'Jira Devflow shown above the prompt (this surface has no panes).' }
  })

  on('prompt.submit', async ($, e, next) => {
    const isComposer = e.origin.kind === 'composer'
    const ticket = isComposer ? TICKET_RE.exec(e.text)?.[1] : undefined
    if (ticket) await setTicket($, ticket)
    await setBaseline($, { isComposer, hashes: await dirtySnapshot($) })
    return next(e)
  })

  on('tool.call', { tool: EDIT_TOOL_RE }, async ($, e, next) => {
    const ran = await next(e)
    const input = e as { file_path?: unknown; notebook_path?: unknown }
    const path = input.file_path ?? input.notebook_path
    if (typeof path !== 'string' || ran.deny !== undefined || ran.isError) return ran
    if (PLAN_FILE_RE.test(path)) await patchPlan($, { path })
    return ran
  }).catch(($, e, next) => next(e))

  // Runs after the plan dialog is answered, whichever option was picked.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    const out = ran.deny === undefined ? (ran.result as { plan?: string | null; filePath?: string } | undefined) : undefined
    void afterPlanExit($, out?.filePath, out?.plan)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    const { answer } = e
    void (async () => {
      const baseline = await getBaseline($)
      await setBaseline($, null)
      await refreshUsage($)
      if (!baseline) return
      const files = fmt.changedSince(baseline.hashes, await dirtySnapshot($))
      const hadEdits = files.length > 0
      const ticket = await getTicket($)
      if (baseline.isComposer && !hadEdits && ticket && answer.length >= MIN_FINDINGS_CHARS) {
        await setFindings($, { ticket, text: answer, isShared: false })
      }
      if (!hadEdits) return
      const card = await getCommit($)
      const pending = await pendingFiles($, [...new Set([...card.files, ...files])])
      if (pending.length === 0) return
      await setCommit($, { files: pending, message: card.message, phase: 'ready' })
      await regenerateMessage($)
    })()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) => renderPane($, e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    return renderBand($, e)
  })
}
