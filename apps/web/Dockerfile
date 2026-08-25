FROM oven/bun:1.4.0-alpine AS bun
FROM node:24.18.0-alpine AS toolchain
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

FROM toolchain AS build
WORKDIR /workspace
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY packages/ui packages/ui
COPY apps/web apps/web
RUN bun run --filter @kitesync/contracts build \
  && bun run --filter @kitesync/ui build \
  && bun run --filter @kitesync/web build

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
