# site-cli-creator

A generator that turns the network calls a website's frontend makes into a plugin with a CLI that coding agents can drive, with built-in drift checks and a feedback loop.

## Language

**CLI skill**:
A skill with its own CLI that wraps one site, with exactly one login or none (`auth: login` or `auth: none`). A generated plugin holds one or more of them, and can mix both kinds.
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

### MCP server

**MCP server**:
A CLI skill serving its Tasks as tools to AI clients that speak MCP, instead of to an agent running its CLI. It runs the same Tasks, Contracts and Session as the CLI.
_Avoid_: connector, MCP plugin, separate server

**Local mode**:
An MCP server running on the user's own computer, started by their AI client, with no address on the internet.
_Avoid_: stdio mode, desktop mode

**Remote mode**:
An MCP server running as a web service on a machine its Owner controls, with an address that web and phone clients can reach.
_Avoid_: hosted mode, cloud mode, lock-1 mode

**Owner**:
The one person a remote-mode MCP server belongs to and acts for. Nobody else can use it.
_Avoid_: admin, user (too broad), tenant

**Server sign-in**:
The Owner proving to their own remote-mode MCP server that they may use it. It says nothing about the site.
_Avoid_: lock 1, MCP login, OAuth (that is how, not what)

**Session**:
What signing in to a site leaves behind for a CLI skill to act as the user there, such as a cookie or a bearer token. It is the site's own login, never derived from a Server sign-in.
_Avoid_: lock 2, credentials, token (too broad)

**Deploy skill**:
A skill that ships inside a plugin and guides the Owner through running one of its CLI skills in remote mode on a host they choose. It holds one host-neutral contract and one section per supported host.
_Avoid_: hosting skill, installer, Railway skill (that is Railway's own)

**Setup page**:
The Owner's page on their remote-mode MCP server where they give it a Session for its site and see whether it is still valid.
_Avoid_: admin page, control panel, dashboard
