# Service observability

`@pkgs/logger` emits one JSON record per event to stdout/stderr. Your service
manager or optional log collector captures those streams. This package does not
deploy a collector, retention policy or alert destination. External services keep
their native instrumentation. This is a shared diagnostic contract, not a claim that
every failure is detected or that distributed tracing is fully deployed.

## New services

Use `createLogger({ name: '<inventory service id>', level: 'info' })` for runtime
events. The sink includes timestamp, severity and service name. If Railway
metadata is present, it adds deployment, replica and commit identifiers; those
fields are optional. Child bindings add the environment
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

## Fleet coverage

The Fleet controller uses shared HTTP correlation, structured unexpected errors
and database readiness errors. Node service logs remain in the system journal;
node metrics stay on loopback. External identity providers, S3 storage and optional
Vault/OpenBao services need operator-managed observability. Fleet does not ship
an auth relay, PostgreSQL deployment, remote cache service, trace collector or
central monitoring stack.

## Incident workflow

1. Capture the response's `X-Request-ID`. Search the controller's stdout/stderr
   logs for that ID and the operation. Background jobs use `jobId` instead.
2. Check `/health`, startup diagnostics, local disk access and your S3 replica.
   For browser authentication, `invalid_client` concerns the upstream client
   credentials; `invalid_grant` requires a fresh sign-in, never a retry of the
   same authorization code. Do not log OAuth payloads while investigating.
3. Inspect the status of the providers you configured. A provider incident is
   not proof that your credentials are invalid.
4. Deploy using your operator workflow. Verify readiness, a fresh sign-in,
   job recovery and the deployed revision's logs. Local tests do not establish
   that production received a fix.
