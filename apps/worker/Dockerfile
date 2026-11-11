FROM node:24-alpine
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
# Installs the worker and the workspace packages it uses, not the root dev tools.
RUN pnpm install --frozen-lockfile --filter @daloy/worker...
USER node
WORKDIR /app/apps/worker
CMD ["node_modules/.bin/tsx", "src/main.ts"]
