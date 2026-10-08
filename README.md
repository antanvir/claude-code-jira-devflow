# claude-code-jira-devflow

A Claude Code mod that adds Jira and git actions to Claude Code, so a ticket can go from analysis to plan, commit and review without leaving the chat.

> Status: first iteration built, not yet tried in a live session.

Everything lives in one **Jira Devflow** panel. It opens when a session starts, or with `/devflow`. A panel is used because VSCode doesn't draw mod content above the prompt box or under a reply.

## Features

- **Jira setup:** the first Jira action asks for your Jira email and saves it for later sessions. *Verify connection* checks that the Atlassian connector is connected and signed in with that email.
- **Ticket:** the mod picks up a ticket key (e.g. `PROJ-1234`) from your prompt, or you can set it in the panel.
- **Update ticket:** sets the status, sets Developed by and appends the labels you enter in the panel (none by default) through the bundled `update-jira-ticket` skill. You choose which of these to apply, and the choice is saved. Nothing else on the ticket is changed.
- **Write AC:** runs the bundled `write-acceptance-criteria` skill for the ticket and saves the criteria to its Acceptance Criteria field (or a comment if the field doesn't exist).
- **Share findings:** after a turn that analysed the ticket without editing files, posts Claude's answer as a Jira comment.
- **Plan files:** after a plan is approved, saves a copy named `<TICKET>-<concise-name>.md` next to the original. Turn on *Add plan as a Jira comment* to post the plan too, whichever approval option you pick.
- **Commit card:** after Claude edits files, lists the touched files and writes a commit message that follows the *Git Commits* section of your CLAUDE.md, with no Co-Authored-By line. Buttons: Stage, Commit, Commit & Push, Regenerate.
- **AI Review:** after a commit or push, asks Claude to start a review agent on `git diff <base>...HEAD` with the model and effort you choose.
- **Usage:** 5-hour, weekly, on-demand and context meters, colour-coded (green below 60%, amber 60–85%, red 85%+), with a **Compact** button.

Both Jira skills ship in [skills/](skills/) and are invoked as `claude-code-jira-devflow:<skill>`, so no personal skills are needed and any same-named skills of your own are left alone.

## Requirements

- Claude Code 2.1.272 or later, with mod (plugin hooks) support
- The Atlassian connector authorised in claude.ai connector settings
- Git

Where it runs: VSCode, Claude Desktop (Code tab) and the terminal. On mobile the panel shows only the ticket.

## Install

Not published yet. To load it from this folder while developing:

- **Terminal:**

  ```
  claude --plugin-dir <path-to-this-repo>
  ```

- **VSCode / Desktop:** add the folder to the `env` block of `~/.claude/settings.json`, then start a new session:

  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\path\\to\\claude-code-jira-devflow" } }
  ```

Once published, install it from a terminal (the `/plugin` slash command is unavailable in VSCode / Desktop):

```
claude plugin marketplace add antanvir/claude-code-jira-devflow
claude plugin install claude-code-jira-devflow@devflow
```

Update later with `claude plugin marketplace update devflow`, then start a new session.

## Development

```
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
```

- `hooks/register.tsx`: every hook and every function that uses `$`. `claude plugin validate` only follows `$` within the file it's declared in, so these can't move to other files.
- `hooks/format.ts`: pure helpers (meters, git parsing, prompts).
- `hooks/constants.ts`: names, thresholds, defaults.
- `types/index.d.ts`: the shape of the panel's session state.

## License

MIT. See [LICENSE](LICENSE).
