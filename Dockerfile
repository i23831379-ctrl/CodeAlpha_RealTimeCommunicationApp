# Builder stage
FROM node:lts-alpine AS builder

WORKDIR /app

# Copy package manifests (including lockfile if present)
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --production

# Copy application source code
COPY . .

# Expose the port the server will listen on (default 3000)
EXPOSE 3000

# Runtime stage (lighter image)
FROM node:lts-alpine AS runtime
WORKDIR /app

# Copy files from builder stage
COPY --from=builder /app .

# Start the server
CMD ["node", "server.js"]
