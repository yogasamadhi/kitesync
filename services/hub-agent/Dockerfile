FROM oven/bun:1.4.0-alpine AS bun
FROM node:24.18.0-alpine AS toolchain
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

FROM toolchain AS base
WORKDIR /workspace
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/hub-agent/package.json services/hub-agent/package.json
RUN bun install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY services/hub-agent services/hub-agent

FROM base AS development
CMD ["sh", "-c", "bun run --filter @kitesync/contracts build && bun run --parallel --filter @kitesync/contracts --filter @kitesync/hub-agent dev"]

FROM base AS build
RUN bun run --filter @kitesync/contracts build && bun run --filter @kitesync/hub-agent build

FROM toolchain AS production-dependencies
WORKDIR /workspace
COPY package.json bun.lock bunfig.toml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/hub-agent/package.json services/hub-agent/package.json
RUN bun install --frozen-lockfile --production --filter @kitesync/hub-agent

FROM node:24.18.0-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /workspace/services/hub-agent/dist ./dist
USER node
CMD ["node", "dist/main.js"]
