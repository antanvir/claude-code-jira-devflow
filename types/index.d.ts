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

// Collapsible pane sections; listed ones are expanded, except 'minimized' (the whole pane).
export type PaneSection = 'update' | 'settings' | 'minimized'

// Typed but unsaved field values; Apply or Save commits them.
export type DraftField = 'email' | 'developedBy' | 'labels' | 'subject' | 'body'
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
      // True when no attached surface placed the pane (e.g. VS Code): draw the band.
      band: boolean
    }
  }
}
