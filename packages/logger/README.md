# Service observability

`@pkgs/logger` emits one JSON record per event to stdout/stderr. Railway collects
those streams; no new collector, retention policy or alert destination is deployed
by this package. Provider-managed and external application services keep their
native instrumentation. This is a shared diagnostic contract, not a claim that
every failure is detected or that distributed tracing is fully deployed.

## New services

Use `createLogger({ name: '<inventory service id>', level: 'info' })` for runtime
events. The sink includes timestamp, severity, service name and available Railway
deployment, replica and commit identifiers. Child bindings add the environment
and subsystem. Avoid raw `console` calls for service errors.

Wrap an HTTP boundary in `observeHttp(log, request, handler, () => routeTemplate)`.
It generates a fresh request ID and trace ID, emits status/duration, and adds
`X-Request-ID` to the response. Incoming public request IDs are ignored. Use a
route template, never a raw URL or path containing user-controlled identifiers.
`logContext()` exposes the IDs to handlers and transport adapters. Successful
health probes are debug events; failed requests remain visible at warn/error.

Wrap database, upstream and other failure boundaries in
`operation('subsystem.action', work)`. Record failures using
`log.error('operation_failed', { error: errorDetails(error) })`.
Causes retain operation names, Bun error codes, PostgreSQL SQLSTATE, recognized
OAuth error codes, upstream status and source frames. Unknown messages are omitted
because database and OAuth errors can contain credentials or personal data.
Add a safe error code or a reviewed static reason when a failure needs more
explanation. Do not log SQL text/parameters, error detail, HTTP bodies or claims.

Log startup, listening, shutdown, and every background-job result. Jobs need a
job ID, operation name, duration and retry delay; a recovery/success event must
follow a recovered failure. Avoid overlapping job runs. Readiness must test actual
dependencies and identify failing components; liveness must stay independent of
dependency availability. Keep health checks read-only.

The sink bounds nesting and collection sizes, serializes Error/BigInt safely,
and redacts common credential keys, bearer values and URL credentials/queries.
This is defense in depth: arbitrary strings and upstream-native logs are not
guaranteed to be free of secrets. Callers must use explicit safe fields and the
error serializer. Do not enable request/response-body logging to diagnose auth.

## Current coverage

| Service                                                      | Instrumentation                                                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth relay gateway                                           | Request/reference IDs, status/duration, database/identity/assets readiness, named callback/cleanup/manager steps, lifecycle and job outcomes |
| Fleet API                                                    | Shared HTTP correlation, structured unexpected errors and database readiness errors; existing fleet metrics and job logs                     |
| Remote cache                                                 | Shared HTTP correlation and structured artifact errors; existing Vault boot/renewal events                                                   |
| Keycloak                                                     | Native JSON console logs, native readiness and existing metrics configuration; gateway forwards request IDs and W3C trace headers            |
| OpenBao                                                      | Native JSON operational logs and existing health probes; secret audit infrastructure remains separately managed                              |
| Externally owned apps, third-party images and fleet machines | Existing `bun run health` inventory probes and native platform/service logs; application instrumentation belongs to their owner              |

Forwarding a trace header does not imply the upstream records it. No trace
collector, span store, synthetic sign-in monitor or new alert route is created
here. Those require their own OpenTofu-owned infrastructure and verified routing.

## Incident workflow

1. Capture the response's `X-Request-ID` (or the reference displayed on an auth
   failure page). Search the service's Railway logs for that ID, then the
   deployment/replica and operation. Background jobs use `jobId` instead.
2. Use `bun run health` to compare failures across services. SQLSTATE `53300`
   identifies exhausted database connections; `42501` is denied database access;
   `28P01` is database authentication failure. `invalid_client` concerns the
   upstream client credentials; `invalid_grant` requires a fresh sign-in, never
   a retry of the same authorization code.
3. Check [Railway status](https://status.railway.com/) before treating dashboard,
   deploy or API failures as local configuration problems. An authorization-like
   API error during an incident is not proof that a token is invalid.
4. Deploy through the saved-plan/CI workflows, then verify readiness, successful
   fresh sign-in, job recovery, and the deployed revision's logs. Local tests are
   not evidence that production received a fix.
