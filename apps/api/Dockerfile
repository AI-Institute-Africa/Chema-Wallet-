# Local/dev image for the API. Runs TypeScript via tsx (no build step yet).
# Build from repo root: docker compose build api
FROM node:22-alpine
WORKDIR /app
RUN npm install -g pnpm@10.33.0
COPY . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production PORT=7600 HOST=0.0.0.0
USER node
EXPOSE 7600
CMD ["sh", "-c", "node --import tsx packages/shared/src/db/cli.ts && exec node --import tsx apps/api/src/server.ts"]
