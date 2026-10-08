// claude-code-jira-devflow: every function that touches `$` lives in this file,
// because the engine follows `$` only into functions declared in the same file.
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type {
  CommitCard,
  DevflowConfig,
  Findings,
  Meter,
  PaneView,
  PlanInfo,
  ReviewChoice,
  TurnBaseline,
  UpdatePart,
  UsageSnapshot,
} from '../types'
import {
  ATLASSIAN_PREFIX,
  COMMAND,
  CONNECTORS_URL,
  DEFAULT_CONFIG,
  EDIT_TOOL_RE,
  GIT_TIMEOUT_MS,
  MIN_FINDINGS_CHARS,
  PANE_ID,
  PANE_TITLE,
  PLAN_FILE_RE,
  PUSH_TIMEOUT_MS,
  REVIEW_EFFORTS,
  REVIEW_MODELS,
  STATUS_OPTIONS,
  STORE_CLOUD_ID,
  STORE_CONFIG,
  STORE_REPO_CONFIG_PREFIX,
  TICKET_RE,
  TIER,
  USAGE_REFRESH_MS,
  UTILITY_MODEL,
} from './constants'
import * as fmt from './format'

type Outcome = { isOk: boolean; text: string }
type GitStep = 'stage' | 'commit' | 'push'
type Tier = keyof typeof TIER | 'primary'

const IDLE_COMMIT: CommitCard = { files: [], message: '', phase: 'idle' }

// --- session state -------------------------------------------------------------
// One literal ref + accessor pair per key: `claude plugin validate` must see each
// `plugin`/`key` literal at its $.state call, so refs are never passed around.

const TICKET = { plugin: 'claude-code-jira-devflow', key: 'ticket' } as const
const CONFIG = { plugin: 'claude-code-jira-devflow', key: 'config' } as const
const USAGE = { plugin: 'claude-code-jira-devflow', key: 'usage' } as const
const COMMIT = { plugin: 'claude-code-jira-devflow', key: 'commit' } as const
const FINDINGS = { plugin: 'claude-code-jira-devflow', key: 'findings' } as const
const PLAN = { plugin: 'claude-code-jira-devflow', key: 'plan' } as const
const REVIEW = { plugin: 'claude-code-jira-devflow', key: 'review' } as const
const VIEW = { plugin: 'claude-code-jira-devflow', key: 'view' } as const
const NOTICE = { plugin: 'claude-code-jira-devflow', key: 'notice' } as const
const BASELINE = { plugin: 'claude-code-jira-devflow', key: 'baseline' } as const

const getTicket = async ($: EngineInterface) => (await $.state.get(TICKET)).value ?? null
const setTicket = ($: EngineInterface, value: string | null) => $.state.set(TICKET, value)
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
const getView = async ($: EngineInterface) => (await $.state.get(VIEW)).value ?? 'main'
const getNotice = async ($: EngineInterface) => (await $.state.get(NOTICE)).value ?? null
const getBaseline = async ($: EngineInterface) => (await $.state.get(BASELINE)).value ?? null
const setBaseline = ($: EngineInterface, value: TurnBaseline | null) => $.state.set(BASELINE, value)

async function notify($: EngineInterface, text: string | null): Promise<void> {
  await $.state.set(NOTICE, text)
}

async function show($: EngineInterface, view: PaneView): Promise<void> {
  await $.state.set(VIEW, view)
}

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
  const config = await getConfig($)
  const usage = await $.session.usage()
  await setUsage($, fmt.toUsageSnapshot(usage, config.onDemandBudgetUsd))
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
    await show($, 'main')
  } else {
    await notify($, info.isOk ? 'Connected, but as a different email' : info.text)
  }
}

// Jira actions need the user's email first (asked once, then kept in $.store).
async function requireTicket($: EngineInterface): Promise<{ ticket: string; config: DevflowConfig } | null> {
  const config = await getConfig($)
  if (!config.email) {
    await show($, 'setup')
    return null
  }
  const ticket = await getTicket($)
  if (!ticket) {
    await notify($, 'No ticket yet: mention one (e.g. PROJ-1234) in a prompt or set it in the panel')
    return null
  }
  return { ticket, config }
}

async function updateTicket($: EngineInterface): Promise<void> {
  const ready = await requireTicket($)
  if (!ready) return
  await show($, 'main')
  void $.prompt.submit({ text: fmt.updateTicketPrompt(ready.ticket, ready.config) })
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
async function afterPlanExit($: EngineInterface): Promise<void> {
  const plan = await getPlan($)
  const ticket = await getTicket($)
  if (!plan.path) return
  const text = String(await $.fs.read(plan.path))
  const reply = await $.model.complete({ model: UTILITY_MODEL, maxTokens: 30, prompt: fmt.planNamePrompt(text) })
  const name = (reply.isAnswered && fmt.slugify(reply.text)) || fmt.headingSlug(text)
  const renamedPath = fmt.namedPlanPath(plan.path, ticket, name)
  await $.fs.write(renamedPath, text)
  await patchPlan($, { renamedPath })
  if (plan.postToJira && ticket) {
    const posted = await addComment($, ticket, text)
    await notify($, posted.isOk ? `Plan added to ${ticket}` : `Plan comment failed: ${posted.text}`)
  }
}

// --- pane ------------------------------------------------------------------

const PART_LABELS: Record<UpdatePart, string> = {
  status: 'Status',
  developedBy: 'Developed by',
  labels: 'Append labels',
}

async function renderPane($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const ticket = await getTicket($)
  const config = await getConfig($)
  const usage = await getUsage($)
  const commit = await getCommit($)
  const findings = await getFindings($)
  const plan = await getPlan($)
  const review = await getReview($)
  const view = await getView($)
  const notice = await getNotice($)

  if (e.surface === 'mobile') {
    const { Text } = $.ui.resolve(e)
    return <Text>{ticket ?? 'No ticket'} · open on desktop or VSCode for actions</Text>
  }

  const { Box, Text, Button, Input, Select, Markdown } = $.ui.resolve(e)
  const isTerminal = e.surface === 'terminal'

  // Button has no colour prop, so non-primary tiers get a coloured frame.
  const action = (key: string, label: string, tier: Tier, onPress: () => Promise<unknown>) =>
    tier === 'primary' || isTerminal ? (
      <Button key={key} label={label} variant={tier === 'primary' ? 'primary' : 'secondary'} onPress={() => void onPress()} />
    ) : (
      <Box key={`${key}-frame`} borderStyle="round" borderColor={TIER[tier]}>
        <Button key={key} label={label} plain onPress={() => void onPress()} />
      </Box>
    )

  const meterRow = (name: string, meter?: Meter) => (
    <Box key={`meter-${name}`} flexDirection="row" gap={1}>
      <Text dimColor>{name.padEnd(9)}</Text>
      {meter ? <Text color={fmt.levelColor(meter.percent)}>{`${fmt.bar(meter.percent)} ${meter.label}`}</Text> : <Text dimColor>n/a</Text>}
    </Box>
  )

  const noticeRow = notice ? (
    <Box key="notice" flexDirection="row" gap={1}>
      <Text color="suggestion">{notice}</Text>
      <Button key="notice-x" label="×" plain onPress={() => void notify($, null)} />
    </Box>
  ) : null

  if (view === 'setup') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Connect Jira to use ticket actions</Text>
        <Input
          key="setup-email"
          label="Jira / Atlassian email"
          placeholder="you@company.com"
          value={config.email}
          submitLabel="Save"
          onSubmit={value => void saveConfig($, { email: value.trim() })}
        />
        <Markdown text={`Authorise the **Atlassian** connector in [claude.ai connector settings](${CONNECTORS_URL}), then verify.`} />
        <Box flexDirection="row" gap={1}>
          {action('verify', 'Verify connection', 'jira', () => verifyConnector($))}
          {action('setup-back', 'Back', 'neutral', () => show($, 'main'))}
        </Box>
        {noticeRow}
      </Box>
    )
  }

  if (view === 'settings' || view === 'update') {
    const togglePart = (part: UpdatePart) =>
      saveConfig($, {
        updateParts: config.updateParts.includes(part)
          ? config.updateParts.filter(p => p !== part)
          : [...config.updateParts, part],
      })
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{view === 'update' ? `Update ${ticket ?? 'ticket'}` : 'Devflow settings'}</Text>
        {(Object.keys(PART_LABELS) as UpdatePart[]).map(part => (
          <Button
            key={`part-${part}`}
            label={`${config.updateParts.includes(part) ? '☑' : '☐'} ${PART_LABELS[part]}`}
            plain
            onPress={() => void togglePart(part)}
          />
        ))}
        <Select
          key="status"
          label="Status"
          options={fmt.toOptions(STATUS_OPTIONS)}
          value={config.status}
          onSelect={value => void saveConfig($, { status: value })}
        />
        <Input
          key="developed-by"
          label="Developed by"
          placeholder={config.email || 'Name or email'}
          value={config.developedBy}
          submitLabel="Save"
          onSubmit={value => void saveConfig($, { developedBy: value.trim() })}
        />
        <Input
          key="labels"
          label="Labels to append (comma-separated)"
          placeholder="e.g. backend, release-notes"
          value={config.labels.join(', ')}
          submitLabel="Save"
          onSubmit={value => void saveConfig($, { labels: value.split(',').map(l => l.trim()).filter(Boolean) })}
        />
        {view === 'settings' ? (
          <Box flexDirection="column" gap={1}>
            <Input
              key="email"
              label="Jira email"
              value={config.email}
              submitLabel="Save"
              onSubmit={value => void saveConfig($, { email: value.trim() })}
            />
            <Input
              key="budget"
              label="On-demand budget (USD)"
              value={String(config.onDemandBudgetUsd)}
              submitLabel="Save"
              onSubmit={value => void saveConfig($, { onDemandBudgetUsd: Number(value) || 0 })}
            />
          </Box>
        ) : null}
        <Box flexDirection="row" gap={1}>
          {view === 'update' ? action('apply', 'Apply to Jira', 'primary', () => updateTicket($)) : null}
          {action('close', view === 'update' ? 'Cancel' : 'Done', 'neutral', () => show($, 'main'))}
        </Box>
        {noticeRow}
      </Box>
    )
  }

  const isAfterCommit = commit.phase === 'pushed' || commit.phase === 'committed'
  const reviewRow = isAfterCommit ? (
    <Box key="review" flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <Select
          key="review-model"
          label="Model"
          options={fmt.toOptions(REVIEW_MODELS)}
          value={review.model}
          onSelect={value => void patchReview($, { model: value })}
        />
        <Select
          key="review-effort"
          label="Effort"
          options={fmt.toOptions(REVIEW_EFFORTS)}
          value={review.effort}
          onSelect={value => void patchReview($, { effort: value })}
        />
      </Box>
      <Box flexDirection="row" gap={1}>
        {action('review', 'AI Review', 'token', () => startReview($))}
        {action('done', 'Done', 'neutral', () => setCommit($, IDLE_COMMIT))}
      </Box>
    </Box>
  ) : null

  const commitCard =
    commit.phase === 'idle' ? null : (
      <Box key="commit" flexDirection="column" gap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text bold>{`Commit (${commit.files.length} file${commit.files.length === 1 ? '' : 's'})`}</Text>
        {commit.files.map(file => (
          <Text key={`file-${file}`} dimColor wrap="truncate-start">{file}</Text>
        ))}
        <Input
          key="commit-message"
          label="Message (no Co-Authored-By)"
          value={commit.message}
          submitLabel="Save"
          onSubmit={value => void patchCommit($, { message: value })}
        />
        {commit.phase === 'ready' ? (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {action('stage', 'Stage', 'neutral', () => runGit($, 'stage'))}
            {action('commit', 'Commit', 'primary', () => runGit($, 'commit'))}
            {action('push', 'Commit & Push', 'warn', () => runGit($, 'push'))}
            {action('regen', '↻ Regenerate', 'neutral', () => regenerateMessage($))}
            {action('dismiss', 'Dismiss', 'neutral', () => setCommit($, IDLE_COMMIT))}
          </Box>
        ) : null}
        {commit.note ? <Text dimColor>{commit.note}</Text> : null}
        {reviewRow}
      </Box>
    )

  const findingsCard =
    findings && !findings.isShared ? (
      <Box key="findings" flexDirection="row" flexWrap="wrap" gap={1}>
        <Text>{`Findings for ${findings.ticket} ready`}</Text>
        {action('share', 'Share findings in Jira', 'jira', () => shareFindings($))}
        {action('findings-x', 'Dismiss', 'neutral', () => setFindings($, null))}
      </Box>
    ) : null

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
        <Text color={TIER.jira} bold>{ticket ?? 'No ticket'}</Text>
        <Text dimColor>{config.email || 'Jira not set up'}</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {action('update', 'Update ticket ▾', 'jira', () => show($, config.email ? 'update' : 'setup'))}
        {action('ac', 'Write AC', 'neutral', () => writeAc($))}
        {action('settings', '⚙ Settings', 'neutral', () => show($, 'settings'))}
      </Box>
      <Input
        key="ticket"
        label="Ticket"
        placeholder="PROJ-1234"
        value={ticket ?? ''}
        submitLabel="Set"
        onSubmit={value => void setTicket($, value.trim().toUpperCase() || null)}
      />
      <Button
        key="plan-jira"
        label={`${plan.postToJira ? '☑' : '☐'} Add plan (.md) as a Jira comment`}
        plain
        onPress={() => void patchPlan($, { postToJira: !plan.postToJira })}
      />
      {plan.renamedPath ? <Text dimColor wrap="truncate-start">{`Plan saved as ${plan.renamedPath}`}</Text> : null}
      {noticeRow}
      {findingsCard}
      {commitCard}
      <Box flexDirection="column">
        {meterRow('5h', usage.fiveHour)}
        {meterRow('Weekly', usage.weekly)}
        {meterRow('On-demand', usage.onDemand)}
        {meterRow('Context', usage.context)}
      </Box>
      <Box flexDirection="row" gap={1}>
        {action('compact', 'Compact', 'warn', () => compact($))}
        {action('refresh', '↻ Usage', 'neutral', () => refreshUsage($))}
      </Box>
    </Box>
  )
}

// --- hooks -----------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await setConfig($, await loadConfig($))
    await $.command.register({ name: COMMAND, description: 'Open the Jira Devflow panel' })
    $.clock.every(USAGE_REFRESH_MS, () => void refreshUsage($))
    void refreshUsage($)
    void $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    return { text: 'Jira Devflow panel opened.' }
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
    void afterPlanExit($)
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
}
