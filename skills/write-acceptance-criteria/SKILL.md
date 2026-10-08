---
name: write-acceptance-criteria
description: Generate QA-ready acceptance criteria from the current session's work and add them to a Jira ticket. Invoked by the Jira Devflow panel's Write AC button.
---

Write acceptance criteria for the work done in this session. If the request names a Jira ticket, also save them to that ticket (steps 7–10).

1. Review the session: what was asked, what was implemented, and what feedback was given and acted on.

2. Identify every distinct feature, fix or behaviour that was implemented or changed.

3. For each, write criteria in plain terms a QA engineer can follow without reading code.
   - Describe WHAT the system should do, not HOW. Focus on business logic over granular detail.
   - Each criterion is one specific, verifiable behaviour.
   - Use "should" statements ("The sync button should…") or "will" statements ("A new modal will be displayed…").
   - Avoid technical jargon.

4. Output a numbered list grouped by feature or fix area, each group under a short bold heading (no numbers on headings). Numbering restarts at 1 in each group:
   ```
   **Webhook Behavior**
   1. First criterion
   2. Second criterion

   **UI Functionality**
   1. First criterion
   ```

5. One sentence per point where possible, two at most.

6. For any management or data-fix command, include the actual command as a sub-point.

## Saving to Jira (when a ticket is named)

7. Fetch the ticket with the Atlassian connector (`getJiraIssue`).

8. Find the "Acceptance Criteria" field (case-insensitive) via `getJiraIssueTypeMetaWithFields`.
   - If it has content, keep it as-is and append the new criteria after a `---` separator: `[existing]\n\n---\n\n[new]`.
   - If it is empty, use the new criteria.

9. Write the result with `editJiraIssue`.

10. If the ticket type has no "Acceptance Criteria" field, add the criteria as a comment (`addCommentToJiraIssue`) instead and say so.
