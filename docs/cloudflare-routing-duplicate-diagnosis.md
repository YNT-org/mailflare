# Registration duplicate routing rule diagnosis

## Root cause

Registration calls `ensureEmailRoutingRuleToWorker` after domain provisioning and
then again through `ensureMailboxDomainRouting` after inserting the mailbox.
The repeated ensure is safe only if the first call correctly recognizes the
existing address rule.

The old search used `isWorkerRouteForAddress`: it required both an address match
and an action already pointing to `mailflare`. A forwarding rule, drop rule, or
rule targeting another Worker therefore looked absent. Mailflare POSTed a second
rule for the same address and Cloudflare rejected it with 409 / 2014.

Two additional paths reached the same invalid POST: only the first list page was
read, and disabled matching rules with a `tag` but no `id` bypassed the update
branch. The supplied production evidence confirms that the address exists; its
actual action, page, and identifier fields were not retrieved. These are verified
code defects and independently reproduced causes of the exact reported error,
not an assertion about unseen production rule fields.

The user explicitly chose to retarget an existing rule to Mailflare. No live rule
was changed or deleted and no deployment was performed.

## Fix

- Match normalized literal recipient addresses independently of the action.
- Read all list pages using the documented maximum of 50 records per page.
- Reuse an enabled rule only when its single action explicitly names Mailflare.
  An absent Worker destination is no longer assumed to mean Mailflare.
- Otherwise PUT the existing ID (or legacy tag), enabling the rule and targeting
  Mailflare while preserving matchers, name, priority, and identity.
- If an existing rule has no usable identifier, stop instead of POSTing a duplicate.
- POST only when no matching address exists. On 409 / 2014, re-read once and
  reconcile the concurrently created rule. Other failures still propagate.
- Registration records only successful creates for deletion during rollback.
  For updates it stores the previous rule and restores it with PUT if a later
  registration step fails. Reused rules are not scheduled for deletion.

The rollback snapshot is scoped to this registration attempt and is best-effort,
as with the existing rollback. Cloudflare and the local database do not form an
atomic transaction; unrelated concurrent administrative edits cannot be locked.

## Reproduction and validation

The tests execute the real API helpers with a simulated Cloudflare rules store
that rejects duplicate addresses. Restoring the original API source makes the
forwarding, tag-only, and later-page cases all fail with 409 / 2014. The patched
source passes those cases, repeated ensure calls, concurrent creation, and
restoration of enabled/disabled forwarding rules after later registration failure.
There are no DELETE requests in any existing-rule test.

All 16 tests pass. Targeted lint passes. Full-project TypeScript checking reports
the same 11 pre-existing diagnostics as before this patch, with none in the
modified source files.

Commands: `node --test tests/*.test.mjs`; targeted ESLint for the modified files;
`node node_modules/typescript/bin/tsc --noEmit --incremental false`.

Cloudflare reference:
[List routing rules](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/methods/list/),
[Update routing rule](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/methods/update/).
