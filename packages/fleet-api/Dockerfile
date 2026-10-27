# syntax=docker/dockerfile:1

# The fleet API: Hono on Bun, raw SQL against the shared Postgres (schema
# `fleet` only), with a React/Mantine client console and offline fallback CSS.
FROM oven/bun:1.4.4 AS manifests
WORKDIR /app
ARG TARGETARCH

COPY package.json bun.lock ./
COPY packages/assert/package.json ./packages/assert/
COPY packages/admin-ui/package.json ./packages/admin-ui/
COPY packages/logger/package.json ./packages/logger/
COPY packages/fleet/package.json ./packages/fleet/
COPY packages/fleet-api/package.json ./packages/fleet-api/

FROM manifests AS production-dependencies
RUN --mount=type=cache,id=bun-1.4.4-${TARGETARCH},target=/root/.bun/install/cache bun install --frozen-lockfile --filter @pkgs/fleet-api --production

FROM manifests AS build
RUN --mount=type=cache,id=bun-1.4.4-${TARGETARCH},target=/root/.bun/install/cache bun install --frozen-lockfile --filter @pkgs/fleet-api

COPY tsconfig.strict.json ./
COPY packages/assert ./packages/assert
COPY packages/logger ./packages/logger
COPY packages/admin-ui ./packages/admin-ui
COPY packages/fleet-api ./packages/fleet-api

# dist/ is excluded from the context; compile all browser assets here.
RUN cd packages/fleet-api && bun run build

FROM oven/bun:1.4.4-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Keep only production dependencies and runtime source/assets. Test tooling and
# browser/compiler packages remain in the build stage.
COPY --chown=bun:bun --from=production-dependencies /app /app
COPY --chown=bun:bun --from=build /app/tsconfig.strict.json ./
COPY --chown=bun:bun --from=build /app/packages/assert/src ./packages/assert/src
COPY --chown=bun:bun --from=build /app/packages/logger/src ./packages/logger/src
COPY --chown=bun:bun --from=build /app/packages/admin-ui/src ./packages/admin-ui/src
COPY --chown=bun:bun --from=build /app/packages/fleet-api/src ./packages/fleet-api/src
COPY --chown=bun:bun --from=build /app/packages/fleet-api/dist ./packages/fleet-api/dist
COPY --chown=bun:bun --from=build /app/packages/fleet-api/tsconfig.json ./packages/fleet-api/
COPY --chown=bun:bun --from=build /app/packages/fleet-api/schema.hcl ./packages/fleet-api/
RUN chown bun:bun /app

# Bun takes the JSX settings (hono/jsx) from the tsconfig in the working
# directory, not from the one beside each file, so run from the package.
WORKDIR /app/packages/fleet-api

EXPOSE 8080

USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/health`); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "src/server.ts"]
