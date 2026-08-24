FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

COPY fake-tool.mjs /usr/local/libexec/gridora-fake-tool.mjs
RUN chmod 0555 /usr/local/libexec/gridora-fake-tool.mjs \
  && ln -s /usr/local/libexec/gridora-fake-tool.mjs /usr/local/bin/steamcmd \
  && ln -s /usr/local/libexec/gridora-fake-tool.mjs /usr/local/bin/ArmaReforgerServer \
  && ln -s /usr/local/libexec/gridora-fake-tool.mjs /usr/local/bin/gridora-game-query

USER 10001:10001
WORKDIR /work/game
CMD ["ArmaReforgerServer", "--gridora-simulated-runtime"]
