FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS dependencies
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/cloud/package.json apps/cloud/package.json
COPY packages/cloud-contract/package.json packages/cloud-contract/package.json
COPY packages/publication-renderer/package.json packages/publication-renderer/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
WORKDIR /workspace
COPY apps/cloud apps/cloud
COPY packages/cloud-contract packages/cloud-contract
COPY packages/publication-renderer packages/publication-renderer
RUN pnpm --filter @imai/knot-cloud-contract build
RUN pnpm --filter @imai/knot-publication-renderer build
RUN pnpm --filter @imai/knot-cloud build

FROM dependencies AS migrator
WORKDIR /workspace
COPY apps/cloud/migrations apps/cloud/migrations
COPY apps/cloud/scripts apps/cloud/scripts
USER node
CMD ["node", "apps/cloud/scripts/migrate.mjs"]

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/cloud/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/cloud/.next/static ./apps/cloud/.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "apps/cloud/server.js"]
