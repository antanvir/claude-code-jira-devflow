---
name: update-jira-ticket
description: Apply the Jira Devflow panel's ticket update (status, Developed by, labels) using the Atlassian connector. Invoked by the panel's Update ticket button.
---

Update one Jira ticket. The request names the ticket key and lists **only** the changes to make, from:

- `status → "<name>"`
- `"Developed by" → <email>`
- `append labels "<a>", "<b>" (keep existing labels)`

Change nothing that is not listed: no assignee, fix version, sprint or other fields. Use the Atlassian connector tools (`getJiraIssue`, `getTransitionsForJiraIssue`, `transitionJiraIssue`, `editJiraIssue`, `lookupJiraAccountId`, `getJiraIssueTypeMetaWithFields`). Use the Jira site the connector exposes (`getAccessibleAtlassianResources`); if there are several, pick the one whose projects include the ticket's project key.

## Steps

1. **Fetch** the ticket with `getJiraIssue`. If it is not found, report the key and stop.

2. **Status** (if requested)
   - If the ticket is already in that status (case-insensitive), skip.
   - Get transitions with `getTransitionsForJiraIssue`. Pick the transition whose **target status name** equals the requested name (case-insensitive); else one whose name contains it.
   - Match on the status **name**, never the status category ("Awaiting Feedback" is not "In Progress").
   - If none matches, do not transition. Report the available target statuses.
   - Apply with `transitionJiraIssue`.

3. **Developed by** (if requested)
   - Resolve the email with `lookupJiraAccountId`. If not found, report it and skip this field.
   - Find the field id: the field named "Developed by" (case-insensitive) in `getJiraIssueTypeMetaWithFields` for the ticket's project and issue type.
   - If the field does not exist on this issue type, skip it silently and say so in the report.
   - Set it to the account id (a user picker field takes `{"accountId": "<id>"}`).

4. **Labels** (if requested)
   - Read the current labels; add each requested label that is missing (exact match, case-sensitive). Keep all existing labels.
   - Skip if nothing is missing.

5. Send all field edits (Developed by, labels) in **one** `editJiraIssue` call. Transitions are separate calls.

6. **Report** in one line, e.g. `PROJ-123: status → In Progress; Developed by → Jane Doe; labels +backend (frontend already present)`. Name anything skipped or failed and why (missing transition, field absent, user not found, permission error, API error message).
