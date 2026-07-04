# --- build stage: compile TypeScript -> dist/ ---
FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage: production deps + compiled JS ---
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production \
    COOKIE_FILE=/data/.cookies.json \
    METRICS_PORT=8080 \
    WAIT_FOR_FULL_AP=true \
    SINGLE_RUN=true

EXPOSE 8080

ENTRYPOINT ["node", "dist/main.js"]
