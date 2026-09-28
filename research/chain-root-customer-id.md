# Where does the Mit YouSee CLI get the chain-root `customerId`?

Issue: hoaj/skills#9. Researched 2026-09-28 against one shape-only browser capture. No live login was made.

## Answer

The chain root is **`personalInfo.customerId` in the response of `POST /shop/api/session-management/post-login`**. That endpoint is the only response in the capture that carries a `customerId` field before the first operation that takes one. The request body is `{ciamId, individualId}`. Neither value comes from an earlier response, so the frontend almost certainly reads both from the OIDC tokens returned by `POST login.yousee.dk/as/token.oauth2`.

So `login` should:

1. Run the OIDC login and keep the bearer and cookie as it does now.
2. Decode the id_token (or access_token) JWT and read the claims that hold `ciamId` and `individualId`. The claim names are not yet verified; see below.
3. Call `post-login` with `{ciamId, individualId}` and store `personalInfo.customerId` in `session.json`. `individualId` is worth storing too, because `getIndividual` and probably `getAssociationsByParty` use it.

Confidence: **high** that `post-login` → `personalInfo.customerId` is what feeds `customerId` (only candidate, and the timing matches). **Medium** that `ciamId`/`individualId` come from JWT claims, and **unknown** which claim names hold them.

## Evidence

Source: `~/.cli-skill-creator/jira-capture/out/calls-2026-09-28T10-52-18-163Z.ndjson`, 105 calls. The capture script (`~/.cli-skill-creator/jira-capture/capture.mjs`) keeps request and response shapes and redacts every value and most headers. Timestamps below are request times (`t`).

### Call order around login

| # | t (UTC) | Call | Id-like inputs | Id-like outputs |
|---|---|---|---|---|
| 2 | 10:52:46.683 | `GET login.yousee.dk/.well-known/openid-configuration` | — | `claims_supported: [string]` (values redacted) |
| 4 | 10:52:47.239 | `POST login.yousee.dk/as/token.oauth2` | form body, not captured | `access_token`, `id_token`, `token_type`, `expires_in` |
| 6 | 10:52:47.936 | GraphQL `getIndividual($individualId: String!)` | `individualId` | no id fields apart from `contactMedium[].id` |
| 7 | 10:52:48.001 | `POST /shop/api/session-management/post-login` | body `{ciamId, individualId}` | **`personalInfo.customerId`**, `personalInfo.cprId`, `personalInfo.customerCategoryId`, `notificationPreferences[].customerId`, `.partyRefId` |
| 8 | 10:52:48.019 | GraphQL `getAssociationsByParty($sourcePartyId, $sourcePartyType, $partyRoleTypes)` | `sourcePartyId` | `partyRole[].id` with `origin` typed `Customer` (`status`), `associatedPartyRole[].origin.id` on `Customer` |
| 9 | 10:52:48.225 | GraphQL `listFtpdServiceUserProducts($customerId: ID!)` | **first `customerId` use** | — |
| 10 | 10:52:48.622 | GraphQL `eCareListBillingAccountsFD($customerId: String!)` | `customerId` | `billingAccount.id`, which feeds the `accountId` operations |
| 14 | 10:52:48.836 | GraphQL `getCustomer($customerId: String!)` | `customerId` | `id`, `engagedParty.id` |
| 19 | 10:52:49.231 | GraphQL `listFtpdProducts($customerId: ID!)` | `customerId` | — |

### Why `post-login` and not the other candidates

- **`post-login` (#7)**: its response has `personalInfo.customerId` as a top-level string field, and it returns before the first `customerId` consumer (#9, 224 ms later). It is the one candidate that is both earlier and explicitly named `customerId`.
- **`getIndividual` (#6)**: the selection set is `IndividualFragment`: name fields, `birthDate`, `gender`, `extendedAttributes` (CPR status keys), `languageRef`, `contactMedium`. It has no customer or party-role link. It is a consumer of `individualId`, not a source of `customerId`.
- **`getAssociationsByParty` (#8)**: its response has `partyRole[].id` whose `origin` resolves to `Customer`, so it could in principle give customer ids. But it goes out at the same moment as `post-login` returns, and its shape is a list: one individual may hold several customer roles. It looks like an account switcher or a check for several accounts, not the default root. It is a reasonable fallback if `post-login` turns out to be unusable from a CLI.
- **`eCareListBillingAccountsFD` (#10)**: takes `customerId` as input, so it cannot be the root. It is where `accountId` (billing account) comes from for the later `ListFilteredBills`, `listPolicyInstances` and similar calls.
- **`listPartyRoles` (#76)**: first called on `/ecare/finance/{id}`, a minute after login, with an opaque `rsqlPredicate`. Too late to be the root.
- **JWT claim containing `customerId` directly**: possible but not supported. If the token held it, the frontend would not need `post-login` to return it. That round trip before the first `customerId` consumer points to the token not carrying it, or at least not being what the frontend uses.

### Where `ciamId` and `individualId` come from

`getIndividual` (#6) already sends `individualId` 700 ms after the token response, and nothing in between returns an id: `localization-content` (#5) is static content. The token endpoint returns only `access_token` and `id_token` as candidates. So `individualId` and `ciamId` come either from claims in one of those JWTs or from app state that existed before this capture (cookie, localStorage). The first is far more likely. "CIAM" is the identity-platform naming; `ciamId` is probably the OIDC `sub` or a custom claim. The capture cannot show which, because `claims_supported` values and the token bodies were redacted.

## Still unverified (what a live look must check)

1. **Decode the `id_token` and `access_token`** from `/as/token.oauth2` (payload only, no signature check needed). Find the claim whose value equals the `ciamId` in the `post-login` request body, and the one that equals `individualId`. Likely `sub` for one of them and a custom claim for the other. Also check whether any claim already equals `personalInfo.customerId`; if one does, `login` can skip `post-login`.
2. **Confirm that `post-login` works from a CLI**: which auth it needs (the capture shows both an `authorization` header and `cookie` sent), and whether it has side effects. The response has `adobePromotionUpdated` and `categoryChanged` booleans, which suggests it updates server-side session or marketing state. That is harmless for a login step but worth knowing.
3. **Confirm that `customerId` in `getCustomer`, `listFtpdProducts` and the others equals `personalInfo.customerId`** (same value, not a related id such as `customerCategoryId`).
4. **Accounts with several customers** (for example private and business): check whether `getAssociationsByParty` returns more than one `Customer` party role, and whether `post-login` then picks one. If it does, the CLI may need a `--customer` override later. Out of scope for #9.
