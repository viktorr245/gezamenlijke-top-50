FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=4321 \
  STORAGE_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force
COPY --from=build /app/dist ./dist

RUN install -d -o node -g node /data
USER node

EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4321/api/auth/session').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "./dist/server/entry.mjs"]
