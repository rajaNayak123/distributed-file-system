# --- build stage ---
FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src

# --- runtime stage ---
FROM node:18-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package*.json ./
EXPOSE 3000
# No VOLUME declared on purpose: the API tier must never depend on host/container
# filesystem persistence (see NON-NEGOTIABLE RULES) - file bytes live in S3 only.
CMD ["node", "src/server.js"]
