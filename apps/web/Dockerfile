FROM node:22-alpine AS dev
WORKDIR /repo
RUN corepack enable
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/api ./apps/api
COPY apps/web/package.json ./apps/web/
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
EXPOSE 5173
ARG VITE_API_URL=
ENV PORT=5173 BASE_PATH=/ NODE_ENV=development VITE_API_URL=$VITE_API_URL
WORKDIR /repo/apps/web
CMD ["./node_modules/.bin/vite", "dev", "--config", "vite.config.ts", "--host", "0.0.0.0"]

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY --from=deps /repo/node_modules ./node_modules
COPY apps/web ./apps/web
WORKDIR /repo/apps/web
ARG VITE_PORT=5173
# Vite inlines VITE_* env vars into the client bundle at build time.
# Pass --build-arg VITE_API_URL=https://... to bake the shared API origin
# into the shared bundle; the fallback in src/lib/api.ts handles local dev.
ARG VITE_API_URL=
ENV PORT=$VITE_PORT BASE_PATH=/ VITE_API_URL=$VITE_API_URL
RUN pnpm run build

FROM nginx:1.27-alpine AS prod
COPY --from=build /repo/apps/web/dist/public /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
