import type { DevflowConfig, GuardConfig } from '../types'

export const PLUGIN = 'jira-devflow'
export const PANE_ID = 'devflow'
export const PANE_TITLE = 'Jira Devflow'
export const GUARD_PANE_ID = 'limit-guard'
export const GUARD_PANE_TITLE = 'Limit Guard'
export const COMMAND = 'devflow'

// Cheap, fast model for commit messages and plan file names.
export const UTILITY_MODEL = 'claude-haiku-4-5-20251001'
export const ATLASSIAN_PREFIX = 'mcp__claude_ai_Atlassian__'
export const CONNECTORS_URL = 'https://claude.ai/settings/connectors'

export const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/
export const PLAN_FILE_RE = /[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$/i
export const EDIT_TOOL_RE = /^(Edit|Write|NotebookEdit)$/

export const USAGE_REFRESH_MS = 30_000
// Bars: green below WARN, orange from WARN, red from DANGER.
export const WARN_PERCENT = 60
export const DANGER_PERCENT = 90
// The 'warning' theme key renders gray in VS Code, so it gets an explicit orange.
export const LEVEL_COLORS = { success: 'success', warning: '#ff9f43', error: 'error' } as const
// A composer turn with no edits and an answer at least this long counts as findings.
export const MIN_FINDINGS_CHARS = 200
export const MAX_DIFF_CHARS = 12_000
export const GIT_TIMEOUT_MS = 30_000
export const PUSH_TIMEOUT_MS = 120_000

// Global key holds user-wide fields; its repo fields (pre per-repo config) seed new repos.
export const STORE_CONFIG = 'config'
export const STORE_REPO_CONFIG_PREFIX = 'config:'
export const GLOBAL_CONFIG_FIELDS = ['email'] as const
export const STORE_CLOUD_ID = 'cloudId'
// Per Jira project: status names seen and the workflow edges learned so far.
export const STORE_WORKFLOW_PREFIX = 'workflow:'

export const DEFAULT_CONFIG: DevflowConfig = {
  email: '',
  status: 'In Progress',
  developedBy: '',
  labels: [],
  updateParts: ['status', 'developedBy', 'labels'],
}

// handoffDir '' resolves to <repo root>/HANDOFF_SUBDIR at load.
export const DEFAULT_GUARD: GuardConfig = {
  isEnabled: true,
  priority: 'percent',
  fiveHour: 95,
  weekly: 97,
  onDemandUsd: 0,
  handoffDir: '',
}
export const GUARD_PRIORITY_OPTIONS = [
  { value: 'percent', label: '% limits (no on-demand spend)' },
  { value: 'onDemand', label: 'On-demand budget' },
]
export const HANDOFF_SUBDIR = '.claude/handoffs'
// Limits are account-wide, so thresholds share one key; only handoffDir stays per repo root.
export const STORE_GUARD = 'guard'
export const STORE_GUARD_PREFIX = 'guard:'
export const GUARD_KINDS = { five_hour: '5h', seven_day: 'Weekly' } as const
// Resume a minute after the reset, so the first request lands in the new window.
export const GUARD_GRACE_MS = 60_000

// Shown until the ticket's project statuses are fetched.
export const STATUS_OPTIONS = ['In Progress', 'Code Review', 'Ready for QA', 'Done']
// Recent issues sampled to list a project's statuses (the connector has no workflow API).
export const STATUS_SAMPLE_SIZE = 100
// Hops allowed when no direct transition reaches the requested status.
export const MAX_TRANSITION_STEPS = 6
export const DEVELOPED_BY_FIELD = 'Developed by'
export const REVIEW_MODELS = ['opus', 'sonnet', 'fable', 'haiku']
export const REVIEW_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export const JIRA_COLOR = '#4c9aff'
// Group frames: dashed at rest, accent on hover (theme keys).
export const GROUP_BORDER = 'subtle'
export const GROUP_BORDER_HOVER = 'suggestion'
export const BAR_CELLS = 6
// Below this many columns the band uses short bars.
export const BAND_NARROW_COLUMNS = 72
export const BAR_CELLS_NARROW = 4
// export const COMPACT_ICON = '⇲' // Compact button disabled for now.
// Pane head and band cards toggle; both sit above the prompt and grow upward,
// so up caret expands, down caret minimizes.
export const PANE_EXPAND_ICON = '▴'
export const PANE_MINIMIZE_ICON = '▾'
