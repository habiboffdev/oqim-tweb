# OQIM Telegram Web K fork — multi-stage build
# Builds the static SPA and serves via Nginx

FROM node:22-alpine AS builder

RUN corepack enable pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN node build

# --- Serve ---
FROM nginx:alpine

COPY --from=builder /app/public /usr/share/nginx/html/tg
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
