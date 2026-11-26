FROM node:24.15.0-bookworm-slim
ARG STH_REVISION=local
LABEL org.opencontainers.image.revision=$STH_REVISION
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p /app/.data && chown node:node /app/.data
COPY src/ ./src/
COPY web/ ./web/
COPY scripts/ ./scripts/
COPY examples/ ./examples/
USER node
ENV NODE_ENV=production STH_CONTAINER=1
EXPOSE 9321
CMD ["node", "src/main.ts"]
