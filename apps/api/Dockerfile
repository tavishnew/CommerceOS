FROM node:22-alpine AS deps
WORKDIR /repo
RUN apk add --no-cache python3 make g++
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
RUN corepack enable && pnpm install --frozen-lockfile --filter api-server...

FROM node:22-alpine AS dev
WORKDIR /repo
RUN apk add --no-cache python3 make g++
RUN corepack enable
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY apps/api ./apps/api
WORKDIR /repo/apps/api
EXPOSE 5000
ENV NODE_ENV=development
CMD ["node", "/repo/node_modules/tsx/dist/cli.mjs", "watch", "src/index.ts"]

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY --from=deps /repo/node_modules ./node_modules
COPY apps/api ./apps/api
WORKDIR /repo/apps/api
RUN pnpm run build

FROM node:22-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./
COPY --from=deps /repo/node_modules ./node_modules
EXPOSE 5000
USER node
CMD ["node", "dist/index.js"]
