FROM node:24-alpine
# Which app to run: api or worker.
ARG APP
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
# Installs the app and the workspace packages it uses, not the root dev tools.
RUN pnpm install --frozen-lockfile --filter "@daloy/${APP}..."
USER node
WORKDIR /app/apps/${APP}
CMD ["node_modules/.bin/tsx", "src/main.ts"]
