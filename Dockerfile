# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4-debian AS litestream
ADD --checksum=sha256:cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-x86_64.tar.gz /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
    && rm /tmp/litestream.tar.gz

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
# Package tsconfigs choose each package's JSX runtime (hono/jsx for the controller).
COPY packages/admin-ui/tsconfig.json packages/admin-ui/tsconfig.json
COPY packages/fleet-controller/tsconfig.json packages/fleet-controller/tsconfig.json
COPY packages/assert/src packages/assert/src
COPY packages/logger/src packages/logger/src
COPY packages/admin-ui/src packages/admin-ui/src
COPY packages/fleet-controller/src packages/fleet-controller/src
RUN bun run build

FROM manifests AS production-dependencies
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-debian AS runtime
LABEL org.opencontainers.image.source="https://github.com/crvouga/fleet"
WORKDIR /app
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=production-dependencies /app/ ./
COPY --from=build /app/packages/assert/src packages/assert/src
COPY --from=build /app/packages/logger/src packages/logger/src
COPY --from=build /app/packages/admin-ui/src packages/admin-ui/src
COPY --from=build /app/packages/fleet-controller/src packages/fleet-controller/src
COPY --from=build /app/packages/fleet-controller/dist packages/fleet-controller/dist
COPY tsconfig*.json ./
COPY packages/fleet-controller/tsconfig.json packages/fleet-controller/tsconfig.json
RUN test "$(litestream version)" = "0.5.17" \
    && mkdir -p /var/lib/fleet && chown bun:bun /var/lib/fleet
ENV NODE_ENV=production PORT=8080 FLEET_DATABASE_PATH=/var/lib/fleet/fleet.db
USER bun
# Bun takes JSX settings from the working directory's tsconfig. From /app it would use
# the root tsconfig, fall back to React JSX, and every page would render "[object Object]".
WORKDIR /app/packages/fleet-controller
EXPOSE 8080
STOPSIGNAL SIGTERM
# Run the supervisor directly so PID 1 receives termination signals.
ENTRYPOINT ["bun", "src/start.ts"]
