# site-cli-creator

A generator that turns the network calls a website's frontend makes into a plugin with a CLI that coding agents can drive, with built-in drift checks and a feedback loop.

## Language

**CLI skill**:
A skill with its own CLI that wraps exactly one login on one site. A generated plugin holds one or more of them.
_Avoid_: site plugin, connector

**Task**:
Something the user wants an agent to be able to do on a site, stated in plain words. Each Task has its own Capture and becomes one command in the generated CLI.
_Avoid_: use case, feature, command (the command is what a Task becomes)

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
A failure caused by the site having changed away from a Contract, as opposed to a session, network or input failure. Like a bug, it can be reported through the plugin's Feedback skill, and only after the user agrees.
_Avoid_: breakage, bug, regression

**Fingerprint**:
The identity of one Drift across all users: plugin, CLI skill, Operation, break type, field path and error code. It is used to deduplicate reports.
_Avoid_: hash, signature

**Feedback skill**:
A skill that ships inside a plugin and files issues on the repo that plugin lives in: Drift, bugs and feature requests. Every generated plugin has one (`<plugin>-feedback`), and so does site-cli-creator. It drafts the issue and files it only after the user approves.
_Avoid_: report (the removed CLI subcommand), reporter

**Starter code**:
The tested base code the generator copies into a new plugin once: routing, the error envelope and classification, login and session, `check`, build, install and release. After the copy it belongs to the plugin, which shares no code with the generator.
_Avoid_: template (nothing is kept in sync), framework, shared runtime

**Capture**:
A recording of the calls a site's frontend makes while the user performs one Task in the browser, kept as shapes only, with no values.
_Avoid_: HAR, recording, trace
