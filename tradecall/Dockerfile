# TradeCall server image. Runs anywhere Docker does; built for
# linux/amd64 so it also runs on Cloudflare Containers (see DEPLOY-CLOUDFLARE.md).
# The full (non-slim) Node image already includes OpenSSL — which Prisma's
# query engine needs — and CA certificates, so no package installs are needed.

# ---- build: compile TypeScript, generate the Prisma client, drop dev deps
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY prisma ./prisma
COPY src ./src
COPY tsconfig.json ./
RUN npx prisma generate && npm run build && npm prune --omit=dev

# ---- run: only what the server needs
FROM node:22-bookworm
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY src/lib ./src/lib
COPY public ./public
COPY scripts/container-start.sh ./scripts/
RUN chmod +x scripts/container-start.sh
EXPOSE 8080
CMD ["scripts/container-start.sh"]
