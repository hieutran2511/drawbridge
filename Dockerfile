FROM node:22-slim

WORKDIR /app

# Install deps
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Copy source and build frontend
# ARG busts cache so .build-version and source changes are always picked up
ARG CACHE_BUST=0
COPY . .
RUN npm run build

# Prune devDependencies after build
RUN npm prune --production

# Persist session data outside the container
VOLUME /app/data

EXPOSE 3062

CMD ["node", "server.js"]
