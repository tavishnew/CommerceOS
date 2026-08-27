FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter @workspace/commerce0s...

FROM node:22-alpine AS dev
WORKDIR /repo
RUN corepack enable
ENV PORT=5173 BASE_PATH=/
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY apps/web ./apps/web
WORKDIR /repo/apps/web
EXPOSE 5173
ENV NODE_ENV=development
CMD ["./node_modules/.bin/vite", "dev", "--config", "vite.config.ts", "--host", "0.0.0.0"]

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY --from=deps /repo/node_modules ./node_modules
COPY apps/web ./apps/web
WORKDIR /repo/apps/web
ARG VITE_PORT=5173
ENV PORT=$VITE_PORT BASE_PATH=/
RUN pnpm run build

FROM nginx:1.27-alpine AS prod
COPY --from=build /repo/apps/web/dist/public /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
