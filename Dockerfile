FROM node:24.15.0-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.config.ts ./
COPY frontend/ ./frontend/
COPY web/ ./web/
COPY src/ ./src/
RUN npm run build

FROM node:24.15.0-bookworm-slim
ARG STH_REVISION=local
LABEL org.opencontainers.image.revision=$STH_REVISION
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p /app/.data && chown node:node /app/.data
COPY src/ ./src/
COPY web/ ./web/
COPY --from=frontend-build /app/frontend/dist/ ./frontend/dist/
COPY frontend/build-if-needed.mjs frontend/node-runtime.mjs ./frontend/
COPY scripts/ ./scripts/
COPY examples/ ./examples/
USER node
ENV NODE_ENV=production STH_CONTAINER=1
EXPOSE 9321
CMD ["node", "src/main.ts"]
