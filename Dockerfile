# Pinned by version and digest; update both together.
FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
# Which app to run: api or worker.
ARG APP
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
# Installs the app and the workspace packages it uses, not the root dev tools.
# The api image also builds the web console, which the API serves (WEB_DIST in docker-compose.yml).
RUN if [ "$APP" = "api" ]; then \
      pnpm install --frozen-lockfile --filter "@daloy/api..." --filter "@daloy/web..." && pnpm --filter @daloy/web build; \
    else \
      pnpm install --frozen-lockfile --filter "@daloy/${APP}..."; \
    fi
USER node
WORKDIR /app/apps/${APP}
CMD ["node_modules/.bin/tsx", "src/main.ts"]
