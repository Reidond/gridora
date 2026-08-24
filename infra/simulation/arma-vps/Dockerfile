FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates docker-cli docker.io iptables nftables util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /opt/gridora
COPY . .
RUN pnpm install --frozen-lockfile

ENTRYPOINT ["/opt/gridora/infra/simulation/arma-vps/entrypoint.sh"]
