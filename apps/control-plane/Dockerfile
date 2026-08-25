FROM oven/bun:1.4.0-alpine AS bun
FROM node:24.18.0-alpine AS toolchain
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

FROM toolchain AS build
WORKDIR /workspace
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
RUN bun install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY apps/control-plane apps/control-plane
RUN bun run --filter @kitesync/contracts build && bun run --filter @kitesync/control-plane build

FROM toolchain AS production-dependencies
WORKDIR /workspace
COPY package.json bun.lock bunfig.toml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
RUN bun install --frozen-lockfile --production --filter @kitesync/control-plane

FROM node:24.18.0-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /workspace/apps/control-plane/dist ./dist
COPY --from=build /workspace/apps/control-plane/migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
