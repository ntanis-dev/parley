# The Parley relay. Build from the repository root:
#   docker build -f relay/Dockerfile -t parley-relay .
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PARLEY_RELAY_HOST=0.0.0.0 \
    PARLEY_RELAY_PORT=8787 \
    PARLEY_RELAY_DATA=/data/parley-relay.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src

RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/cli.js", "relay"]
