# Stage 1: Base Runtime Environment
# Using Alpine for the smallest possible footprint ("Nano" size)
FROM node:23-alpine AS base
WORKDIR /app

# Stage 2: Dependencies & Build Tools
# This stage installs development tools needed for native module compilation
FROM base AS builder
# Install build essentials for packages like node-gyp or potential native extensions
RUN apk add --no-cache python3 make g++ 
COPY package.json ./
# Install all dependencies including devDependencies for any build steps
RUN npm install --legacy-peer-deps --package-lock=false

# Stage 3: Production Dependency Optimization
# This stage installs ONLY production dependencies to keep the final image clean
FROM base AS prod-deps
COPY package.json ./
RUN npm install --omit=dev --legacy-peer-deps --package-lock=false

# Stage 4: Final Production Image
# This is the actual "Nano" image that will be deployed
FROM base AS runner
# Copy only the necessary production dependencies
COPY --from=prod-deps /app/node_modules ./node_modules
# Copy application source code
COPY . .

# Environment configuration
ENV NODE_ENV=production
EXPOSE 5000

# Start the server
CMD ["node", "server.mjs"]
