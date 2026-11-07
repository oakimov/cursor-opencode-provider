FROM oven/bun:1.4.4
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates coreutils git nodejs openssl procps python3 util-linux zsh \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 test-runner && mkdir -p /src && chown test-runner:test-runner /src
WORKDIR /src
