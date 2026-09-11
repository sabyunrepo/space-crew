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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && mkdir -p /data \
    && chown -R node:node /data /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist-server/index.js"]
