# syntax=docker/dockerfile:1
FROM litestream/litestream:0.5.17@sha256:4b02b9859a6b6b4087d8b8944e15f7e984bd7957cba322bbeee38b0e27b9656a AS litestream

FROM oven/bun:1.4.4-debian AS manifests
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/assert/package.json packages/assert/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/admin-ui/package.json packages/admin-ui/package.json
COPY packages/fleet/package.json packages/fleet/package.json
COPY packages/fleet-controller/package.json packages/fleet-controller/package.json

FROM manifests AS build
RUN bun install --frozen-lockfile
COPY tsconfig*.json ./
COPY packages/assert/src packages/assert/src
COPY packages/logger/src packages/logger/src
COPY packages/admin-ui/src packages/admin-ui/src
COPY packages/fleet-controller/src packages/fleet-controller/src
RUN bun run build

FROM manifests AS production-dependencies
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-debian AS runtime
WORKDIR /app
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=production-dependencies /app/ ./
COPY --from=build /app/packages/assert/src packages/assert/src
COPY --from=build /app/packages/logger/src packages/logger/src
COPY --from=build /app/packages/admin-ui/src packages/admin-ui/src
COPY --from=build /app/packages/fleet-controller/src packages/fleet-controller/src
COPY --from=build /app/packages/fleet-controller/dist packages/fleet-controller/dist
COPY tsconfig*.json ./
RUN test "$(litestream version)" = "0.5.17" \
    && mkdir -p /var/lib/fleet && chown bun:bun /var/lib/fleet
ENV NODE_ENV=production PORT=8080 FLEET_DATABASE_PATH=/var/lib/fleet/fleet.db
USER bun
EXPOSE 8080
STOPSIGNAL SIGTERM
# Run the supervisor directly so PID 1 receives termination signals.
ENTRYPOINT ["bun", "packages/fleet-controller/src/start.ts"]
