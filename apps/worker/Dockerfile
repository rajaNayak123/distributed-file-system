FROM node:20-alpine

RUN addgroup -S worker && adduser -S worker -G worker

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY scripts/ ./scripts/

USER worker

CMD ["node", "src/worker.js"]
