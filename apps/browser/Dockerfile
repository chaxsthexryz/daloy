# The browser service (decision 0108). Microsoft's Playwright image ships Chromium for this exact Playwright version,
# for linux/amd64 and linux/arm64 (Oracle's free ARM machine). Pinned by version and digest; update both together,
# and keep the version equal to "playwright" in apps/browser/package.json.
FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# This image has Node 26, which no longer ships corepack, so the pnpm version from package.json is installed with npm.
RUN npm install -g pnpm@10.34.9
COPY . .
# Only the service and the engine package it reads BLOCKED_RANGES and the action schema from.
RUN pnpm install --frozen-lockfile --filter "@daloy/browser..."
USER pwuser
WORKDIR /app/apps/browser
CMD ["node_modules/.bin/tsx", "src/main.ts"]
