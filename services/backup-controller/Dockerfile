FROM oven/bun:1.4.0-alpine AS bun
FROM node:24.18.0-alpine AS toolchain
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

FROM toolchain AS build
WORKDIR /workspace
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY services/backup-controller/package.json services/backup-controller/package.json
RUN bun install --frozen-lockfile
COPY services/backup-controller services/backup-controller
RUN bun run --filter @kitesync/backup-controller build

FROM node:24.18.0-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/services/backup-controller/dist ./dist
USER node
ENTRYPOINT ["node", "dist/main.js"]
