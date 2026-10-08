export type DevflowConfig = {
  email: string
  status: string
  developedBy: string
  labels: string[]
  onDemandBudgetUsd: number
  updateParts: UpdatePart[]
}

export type UpdatePart = 'status' | 'developedBy' | 'labels'

export type Meter = { percent: number; label: string; resetsAt?: string }

export type UsageSnapshot = {
  fiveHour?: Meter
  weekly?: Meter
  onDemand?: Meter
  context?: Meter
}

export type CommitPhase = 'idle' | 'ready' | 'busy' | 'committed' | 'pushed'

export type CommitCard = {
  files: string[]
  message: string
  phase: CommitPhase
  note?: string
}

export type Findings = { ticket: string; text: string; isShared: boolean }

export type PlanInfo = { path?: string; renamedPath?: string; postToJira: boolean }

export type ReviewChoice = { model: string; effort: string }

export type PaneView = 'main' | 'setup' | 'settings' | 'update'

declare module 'claude-code' {
  interface PluginState {
    'claude-code-jira-devflow': {
      ticket: string | null
      config: DevflowConfig
      usage: UsageSnapshot
      commit: CommitCard
      findings: Findings | null
      plan: PlanInfo
      review: ReviewChoice
      view: PaneView
      notice: string | null
    }
  }
}
