# syntax=docker/dockerfile:1.7

FROM oven/bun:1.4.0 AS application
ARG KITESYNC_VERSION=1.0.0
USER root
WORKDIR /src

COPY package.json bun.lock bunfig.toml tsconfig.base.json tsconfig.scripts.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY vendor/syncthing/UPSTREAM.json vendor/syncthing/NOTICE.kitesync.txt ./vendor/syncthing/

RUN bun install --frozen-lockfile
RUN bun run predev && bun run --filter @kitesync/web build
RUN mkdir -p /out/state && \
    KITESYNC_VERSION="${KITESYNC_VERSION}" \
    bun scripts/package-node.mjs --compile-only --output /out/kitesync

FROM golang:1.26.0-alpine AS syncthing
ARG TARGETARCH
WORKDIR /src/vendor/syncthing/upstream

COPY vendor/syncthing/upstream ./
COPY scripts/verify-syncthing-modules.go /src/scripts/verify-syncthing-modules.go
COPY vendor/syncthing/GO_MODULES.json /src/vendor/syncthing/GO_MODULES.json
RUN printf '%s  %s\n' \
      '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04' LICENSE \
      'a129d6ae9cf20593fab4b1fb04ac09b176c4942d3a4bec9394f9c888fe2d1bd1' go.mod \
      '7e9606117eca33e9263181a3d0141e403c940c55022a061d8ed9e22d4bda2acd' go.sum \
      | sha256sum -c && \
    mkdir -p /out && \
    CGO_ENABLED=0 \
    GOFLAGS='-mod=readonly -buildvcs=false' \
    GOWORK=off \
    BUILD_HOST=build.kitesync.local \
    BUILD_USER=kitesync \
    SOURCE_DATE_EPOCH=1785792965 \
    go run -mod=readonly build.go \
      -goos linux \
      -goarch "${TARGETARCH}" \
      -version v2.1.3 \
      -no-upgrade \
      -tags 'sqlite_omit_load_extension sqlite_dbstat' \
      -build-out /out/syncthing \
      build syncthing && \
    go run /src/scripts/verify-syncthing-modules.go \
      /src/vendor/syncthing/GO_MODULES.json \
      /out/syncthing

FROM debian:bookworm-slim

ARG KITESYNC_VERSION=1.0.0
ARG KITESYNC_REVISION=unknown
LABEL org.opencontainers.image.title="KiteSync Node" \
      org.opencontainers.image.source="https://github.com/yogasamadhi/kitesync" \
      org.opencontainers.image.version="${KITESYNC_VERSION}" \
      org.opencontainers.image.revision="${KITESYNC_REVISION}"

RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates tzdata && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 10001 kitesync && \
    useradd --system --uid 10001 --gid kitesync --home-dir /var/lib/kitesync --shell /usr/sbin/nologin kitesync && \
    install -d -o kitesync -g kitesync -m 0750 /var/lib/kitesync /data

ENV KITESYNC_HEADLESS=1 \
    KITESYNC_STATE_DIR=/var/lib/kitesync \
    KITESYNC_SYNCTHING_BINARY=/usr/local/bin/syncthing

COPY --from=application --chown=kitesync:kitesync /out/kitesync /usr/local/bin/kitesync
COPY --from=application --chown=kitesync:kitesync /out/state /var/lib/kitesync
COPY --from=syncthing --chown=kitesync:kitesync /out/syncthing /usr/local/bin/syncthing
COPY --chown=kitesync:kitesync vendor/syncthing/SYNCTHING_THIRD_PARTY_LICENSES.txt /usr/share/licenses/kitesync/THIRD_PARTY_NOTICES.txt
COPY --chown=kitesync:kitesync vendor/syncthing/NOTICE.kitesync.txt /usr/share/licenses/kitesync/SYNCTHING_NOTICE.txt
COPY --chown=kitesync:kitesync vendor/syncthing/upstream/LICENSE /usr/share/licenses/kitesync/SYNCTHING_LICENSE.txt
COPY --chown=kitesync:kitesync vendor/syncthing/GO_MODULES.json /usr/share/licenses/kitesync/SYNCTHING_GO_MODULES.json
COPY --chown=kitesync:kitesync vendor/syncthing/UPSTREAM.json /usr/share/licenses/kitesync/SYNCTHING_SOURCE.json

USER kitesync:kitesync
VOLUME ["/var/lib/kitesync", "/data"]
EXPOSE 3210/tcp 22000/tcp 22000/udp 21027/udp
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/kitesync"]
CMD ["serve"]
