# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV VITE_BACKEND_MODE=server
RUN npm run build && npm run build:server

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
# The server bundle (dist-server/index.js) only imports two bare specifiers
# at runtime - "ws" and "zod" (everything else it uses is either a node:
# builtin or bundled first-party code). Installing the full app
# package.json here would pull in react/vite/supabase/etc into the runtime
# image for nothing, so install a minimal, version-pinned package.json
# instead - versions must match package-lock.json exactly.
COPY server/runtime-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund --package-lock=false \
    && mkdir -p /data \
    && chown -R node:node /data
# /app stays root-owned (read-only from the app's perspective); only /data
# (the mounted volume the app actually writes to) is owned by node.
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:${PORT:-8080}/healthz || exit 1
CMD ["node", "dist-server/index.js"]
