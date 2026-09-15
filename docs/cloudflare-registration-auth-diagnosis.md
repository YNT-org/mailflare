# Registration Cloudflare authentication diagnosis

## Resolved production issue

The user confirmed that upgrading to Workers Paid and onboarding
`yournextthing.org.uk` to Email Sending resolved the sending entitlement failure.
The investigation below is historical. Registration now reaches a separate
routing-rule conflict; see [the duplicate-rule diagnosis](cloudflare-routing-duplicate-diagnosis.md).

## Historical finding before entitlement resolution

Production has CF_TOKEN only. CF_API_KEY and CF_EMAIL are absent, so legacy
credential precedence is ruled out. The speculative precedence change has been
removed from this patch; authentication behavior is unchanged.

For the reported POST, the exact request constructed by registration is:

```text
POST https://api.cloudflare.com/client/v4/zones/{zone_id}/email/sending/subdomains
Content-Type: application/json
Authorization: Bearer <complete trimmed CF_TOKEN>

{"name":"yournextthing.org.uk"}
```

There is no suffix after `subdomains`. The only POST to a sending endpoint in this
registration path is `createSendingSubdomain`. It follows a successful GET of the
same path with no matching domain. DNS inspection is GET, never POST. If the
reported method is the downstream POST, the previous GET already accepted the
same token on the same endpoint. That argues against a blanket rejection of
User API Tokens and points toward an operation-specific authorization or service
precondition. This is an inference from the code and reported method, not a
retrieved production request trace. The source's formatted error omits the
method, so an outer POST /api/auth/register alone cannot establish the downstream
method; the new safe diagnostic includes it.

The token is only trimmed. No format-dependent parsing, splitting, prefix
removal, environment mutation, or different runtime credential occurs in this
configuration. No registration caller overrides authentication headers.

## Public Cloudflare evidence checked on 2026-09-15

- The [list](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/methods/list/)
  and [create](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/methods/create/)
  reference pages list API Email + Global API Key security and omit Bearer tokens.
- The [published OpenAPI schema](https://github.com/cloudflare/api-schemas/blob/main/openapi.json)
  has the same omission. However, it also omits Bearer for the Email Routing DNS
  endpoints. The omission alone is insufficient to conclude token rejection.
- Cloudflare's [Wrangler Email client](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/email-routing/client.ts)
  uses its normal credential-aware API client for the exact GET and POST sending
  subdomain endpoints. The installed Wrangler 4.127.1 code confirms that its shared
  `addAuthorizationHeader` uses `Bearer ${auth.apiToken}` for API token credentials;
  there is no sending-specific Global API Key requirement or cfut_ transformation.
- Schema permission requirements differ by operation: GET requires
  `com.cloudflare.api.account.email.sending.read`; POST requires
  `com.cloudflare.api.account.email.sending.create`. These are account permissions
  even though the URL contains a zone ID. This establishes what to investigate,
  not that the production token is missing a permission.
- The create reference describes an Email Sending entitlement prerequisite.
  Neither the production account entitlement nor its authorization decision is
  present in the supplied evidence.
- The [send-email REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
  is a different account-level operation. Its documented 10101/10103/10105 errors
  cannot be used to decode this provisioning endpoint's generic 2036 response.

Conclusion: public code supports a Bearer-token client path for this endpoint;
there is no sound basis to claim that all User API Tokens are unsupported or that
switching to a Global API Key is the fix. The exact reason for the production
401/2036 cannot be established from token activity plus a generic rejection.
The previous mocked legacy scenario was not a production reproduction.

No credential was used or requested for this continuation. No authenticated
Cloudflare log connector or existing production log export is available in this
workspace. No live registration, authenticated probe, permission change,
credential change, or deployment was performed. Under the no-credentials
constraint, the remaining evidence must come from existing sanitized logs or
Cloudflare's authorization trace for the failed request.

### Evidence that was missing before entitlement resolution

A sanitized existing record should distinguish the downstream GET and POST and
show the HTTP status/error code for each. If GET succeeded and POST failed,
Cloudflare must distinguish the account-level create authorization decision from
the account/zone Email Sending entitlement check. An existing Cloudflare request
identifier and timestamp can let their support trace that decision; no secret
value is needed. Do not change permissions, account plan, or credentials based
solely on the public schema or error 2036.

## Complete registration trace

1. `src/app/(auth)/register/utils.ts` posts to `/api/auth/register`.
2. The route obtains Worker bindings through `getEnv()` →
   `getCloudflareContext().env`, checks first-run state and validates input.
3. With Turnstile configured, `verifyTurnstileToken` sends POST to
   `https://challenges.cloudflare.com/turnstile/v0/siteverify`. This uses the
   separate TURNSTILE_SECRET_KEY in its JSON body, not CF_TOKEN or Bearer auth.
4. After checking for a duplicate user, registration inserts the provisional
   admin and calls `addDomainForUser` → `provisionDomainOnCloudflare`.
5. Provisioning makes these API calls, all through `cfRequest` at
   `https://api.cloudflare.com/client/v4`:
   - GET `/zones?name={candidate}&status=active`, trying the hostname then parent
     candidates until an exact zone is found.
   - If routing is enabled: GET `/zones/{zone}/email/routing`; GET
     `/zones/{zone}/email/routing/rules/catch_all` if routing was already enabled
     (or the settings read failed); POST `/zones/{zone}/email/routing/dns`;
     PUT `/zones/{zone}/email/routing/rules/catch_all`.
   - If sending is enabled (the registration default): GET
     `/zones/{zone}/email/sending/subdomains`; POST to the same endpoint only
     when the hostname has no existing sending subdomain.
6. `addDomainForUser` saves the domain, synchronizes any existing all-domain
   mailboxes via routing-rule calls, then calls `getDomainDns`: parallel GETs
   for `/email/routing/dns`, `/email/routing`, and (when sending requested)
   `/email/sending/subdomains`, all under `/zones/{zone}`. When a sending tag
   exists it also GETs `/email/sending/subdomains/{tag}/dns`.
7. Registration calls `ensureEmailRoutingRuleToWorker`: GET
   `/zones/{zone}/email/routing/rules`; reuse an enabled match, PUT
   `/zones/{zone}/email/routing/rules/{id}` for a disabled match, or POST
   `/zones/{zone}/email/routing/rules` for a new address. It inserts the mailbox
   and repeats this ensure sequence for its primary and applicable alias/domain
   addresses through `ensureMailboxDomainRouting`. Finally it creates a session.
8. When a rollback has received provisioning changes, it can GET routing rules
   then DELETE a matching address rule, DELETE a newly created sending subdomain,
   PUT the previous catch-all, and DELETE routing DNS that this attempt enabled.
   Registration also deletes the partial user on error and returns HTTP 502.

Existing cleanup limitation: if provisioning throws before returning its changes
(including a sending API 401), the caller has no changes object and cannot roll
back preceding routing mutations. This was observed during tracing and left
unchanged to keep this patch focused on authentication.

## Diagnostics and reproduction

`cfRequest` logs only CF_TOKEN existence, a fixed `cfut_`/`other`/`empty` type
label, raw length, whitespace presence, endpoint without query, method, HTTP
status, and numeric Cloudflare error codes. No secret substring, headers, body,
or API error message is logged by the diagnostic. Non-JSON responses still log
their status. Network failures before a response have no HTTP diagnostic.

`node --test tests/*.test.mjs` executes the actual API and provisioning modules
with synthetic tokens and mocked HTTP responses. The production-shaped regression
accepts a token-only configuration through GET list, then rejects the exact POST
creation with 401/2036 while asserting the complete Bearer token and request body.
This proves the request construction and failure propagation, not Cloudflare's
underlying reason for rejecting production.
