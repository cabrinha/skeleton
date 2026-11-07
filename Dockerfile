# --- build stage: compile TypeScript -> dist/ ---
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage: production deps + compiled JS ---
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Writable data dir for the cookie file, owned by the unprivileged `node` user
# that ships with the official image. Run as that user, not root.
RUN mkdir -p /data && chown -R node:node /data /app

ENV NODE_ENV=production \
    COOKIE_FILE=/data/.cookies.json \
    METRICS_PORT=8080 \
    WAIT_FOR_FULL_AP=true \
    SINGLE_RUN=true

EXPOSE 8080
VOLUME ["/data"]

USER node

ENTRYPOINT ["node", "dist/main.js"]
