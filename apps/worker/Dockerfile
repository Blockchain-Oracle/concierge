# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/
COPY packages packages
RUN pnpm install --frozen-lockfile --filter @concierge/worker...

FROM deps AS build
WORKDIR /app
COPY apps/worker apps/worker
RUN pnpm --filter @concierge/worker run build

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /app/apps/worker/dist /app/apps/worker/dist
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/apps/worker/node_modules /app/apps/worker/node_modules
ENV NODE_ENV=production
USER node
CMD ["node", "/app/apps/worker/dist/index.js"]
