export type DevflowConfig = {
  email: string
  status: string
  developedBy: string
  labels: string[]
  updateParts: UpdatePart[]
}

export type UpdatePart = 'status' | 'developedBy' | 'labels'

export type Meter = { percent: number; label: string; resetsAt?: string }

export type UsageSnapshot = {
  fiveHour?: Meter
  weekly?: Meter
  context?: Meter
}

export type CommitPhase = 'idle' | 'ready' | 'busy' | 'committed' | 'pushed'

export type CommitCard = {
  files: string[]
  message: string
  phase: CommitPhase
  note?: string
}

// One Jira project's known statuses and the transitions seen between them.
export type Workflow = { statuses: string[]; edges: Record<string, string[]> }

export type ProjectStatuses = { project: string; statuses: string[]; isLoading: boolean }

export type Findings = { ticket: string; text: string; isShared: boolean }

export type PlanInfo = { path?: string; renamedPath?: string; postToJira: boolean }

export type ReviewChoice = { model: string; effort: string }

// Dirty files (absolute path → blob hash) when the prompt was sent.
export type TurnBaseline = { isComposer: boolean; hashes: Record<string, string> }

// Collapsible sections; listed ones are expanded, except 'minimized' (the whole pane)
// and 'bandExpanded' (the band's cards above the meters; collapsed by default).
export type PaneSection = 'update' | 'settings' | 'minimized' | 'bandExpanded'

// Which limit pauses when an on-demand budget is set: the % thresholds, or the
// budget (a spilled window may then spend up to onDemandUsd on-demand).
export type GuardPriority = 'percent' | 'onDemand'

// Limit Guard settings, per repo. onDemandUsd 0 = off, and priority is then moot.
export type GuardConfig = {
  isEnabled: boolean
  priority: GuardPriority
  fiveHour: number
  weekly: number
  onDemandUsd: number
  handoffDir: string
}

export type GuardTrip = { kind: string; resetsAt: string; reason: string }
export type GuardPause = GuardTrip & { pausedAt: number; isWriting: boolean; handoffPath?: string }
// Session cost when a window first read full; on-demand spend counts from it.
export type GuardSpend = { resetsAt: string; baseUsd: number }

export type GuardField = 'guardFiveHour' | 'guardWeekly' | 'guardOnDemand' | 'guardDir'

// Typed but unsaved field values; Apply or Save commits them.
export type DraftField = 'email' | 'developedBy' | 'labels' | 'subject' | 'body' | GuardField
export type Drafts = Partial<Record<DraftField, string>>
// Save count per field; part of the Input key so a save remounts it with the saved value.
export type SaveRevs = Partial<Record<DraftField, number>>

declare module 'claude-code' {
  interface PluginState {
    'jira-devflow': {
      ticket: string | null
      statuses: ProjectStatuses | null
      config: DevflowConfig
      usage: UsageSnapshot
      commit: CommitCard
      findings: Findings | null
      plan: PlanInfo
      review: ReviewChoice
      open: PaneSection[]
      drafts: Drafts
      revs: SaveRevs
      notice: string | null
      baseline: TurnBaseline | null
      // True after the pane is closed; the band then shows its cards.
      paneClosed: boolean
      guard: GuardConfig
      guardPause: GuardPause | null
      guardSpend: GuardSpend | null
      // A window's resetsAt that "Resume now" quieted until it resets.
      guardQuiet: string | null
    }
  }
}
