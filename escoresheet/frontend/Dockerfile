# Use Node 20
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the app (VITE_BACKEND_URL is passed as build arg)
ARG VITE_BACKEND_URL
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
RUN npm run build

# Production stage - serve static files
FROM node:20-alpine AS runner

WORKDIR /app

# Install serve globally
RUN npm install -g serve

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Railway provides PORT env var
ENV PORT=3000
EXPOSE 3000

# Start server using shell to expand $PORT
CMD sh -c "serve dist -s -l tcp://0.0.0.0:\$PORT"
