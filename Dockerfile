# Ambree "Book the guide": a small image that runs TypeScript directly (Node 22 type stripping).
# The root filesystem can be read-only; sqlite writes only to /data (a mounted volume).
# Built on the host, never on a laptop (see DEPLOY.md). Same digest-pinned node:22-alpine as ambree-qloo
# (TODO-CHECK: that this digest's Node is >= 22.18 with node:sqlite, as qloo's is).

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    NODE_NO_WARNINGS=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY LICENSE NOTICE.md ./
USER node
EXPOSE 8080
CMD ["node","src/server.ts"]
