# cli-skill-creator

A generator that turns the network calls a website's frontend makes into a plugin with a CLI that coding agents can drive, with built-in drift checks and a feedback loop.

## Language

**Operation**:
One distinct call a generated CLI makes to a site: a method plus path for REST, or an `operationName` for GraphQL. It is the unit a Contract covers.
_Avoid_: endpoint (one GraphQL URL carries many Operations), call

**Contract**:
What a generated CLI expects from one Operation: its request, and the shape of only the response fields the CLI reads.
_Avoid_: fixture, spec

**Effect**:
Whether an Operation changes data on the site (write) or not (read), as declared in its Contract rather than inferred from its method.
_Avoid_: side effect, mutation (a GraphQL mutation can be a read in practice)

**Drift**:
A failure caused by the site having changed away from a Contract. It is the only failure kind that files an issue automatically, as opposed to a session, network or input failure.
_Avoid_: breakage, bug, regression

**Fingerprint**:
The identity of one Drift across all users: plugin, Operation, break type and field path. It is used to deduplicate reports.
_Avoid_: hash, signature

**Capture**:
A recording of the calls a site's frontend makes during a browsing session, kept as shapes only, with no values.
_Avoid_: HAR, recording, trace
