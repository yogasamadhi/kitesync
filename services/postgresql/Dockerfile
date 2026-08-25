FROM postgres:17-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates pgbackrest \
  && rm -rf /var/lib/apt/lists/*
