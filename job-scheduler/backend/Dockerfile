FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
# No lockfile is committed for this project, so `npm ci` would refuse to run.
RUN npm install --no-audit --no-fund

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

# Default command (will be overridden in docker-compose)
CMD ["node", "dist/index.js"]
