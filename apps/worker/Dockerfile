FROM node:20-alpine

# Create a non-root user for security
RUN addgroup -S worker && adduser -S worker -G worker

WORKDIR /app

# Install dependencies first (layer cache friendly)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/
COPY scripts/ ./scripts/

# Switch to non-root user
USER worker

# The worker is not an HTTP server — it has no exposed port.
# It long-polls SQS and processes messages until the process is killed.
CMD ["node", "src/worker.js"]
