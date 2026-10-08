import { expect, test } from 'claude-code/testing'

import { PANE_ID, PANE_TITLE } from '../hooks/constants'

const SCROLL = { offset: 0, bodyRows: 6 }
const PANE = { title: PANE_TITLE, isFocused: false, bodyColumns: 60, placement: 'inline', scroll: SCROLL, view: {} } as const
const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} } as const

// mount rejects with the reason when a surface's element table refuses the tree.
test('pane validates on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'jira-devflow', surface, component: 'Pane', requestId: PANE_ID, props: PANE })
    expect(await ui.find({ type: 'Text', text: /No ticket/ })).toBeDefined()
    await ui.unmount()
  }
})

test('sections expand in place and typed labels show as unsaved', async $ => {
  const first = await $.ui.mount({ plugin: 'jira-devflow', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: PANE })
  await first.press({ key: 'update' })
  await first.press({ key: 'settings' })
  await first.input({ key: 'labels', text: 'a, b', kind: 'change' })
  await first.unmount()
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'jira-devflow', surface, component: 'Pane', requestId: PANE_ID, props: PANE })
    expect(await ui.find({ type: 'Text', text: /Apply to/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Jira setup/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /unsaved/ })).toBeDefined()
    await ui.unmount()
  }
})

test('usage band draws on every surface without on-demand', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'jira-devflow', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: /^Context$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /On-demand/ })).toBe(undefined)
    await ui.unmount()
  }
})
