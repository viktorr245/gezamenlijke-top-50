FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ARG TARGETARCH
ARG YT_DLP_VERSION=2026.07.04

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    amd64) YT_DLP_ASSET=yt-dlp_linux; YT_DLP_SHA256=6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae ;; \
    arm64) YT_DLP_ASSET=yt-dlp_linux_aarch64; YT_DLP_SHA256=b6ce97646773070d7a7ffd6bbbdcaecb47c48483909c54c915bf08a7a9b5e0b1 ;; \
    *) echo "Niet-ondersteunde architectuur voor yt-dlp: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  export YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${YT_DLP_ASSET}"; \
  node -e 'fetch(process.env.YT_DLP_URL).then((response) => { if (!response.ok) throw new Error(`Download mislukt: ${response.status}`); return response.arrayBuffer(); }).then((buffer) => require("node:fs").writeFileSync("/usr/local/bin/yt-dlp", Buffer.from(buffer)))'; \
  echo "${YT_DLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum --check --status; \
  chmod 0755 /usr/local/bin/yt-dlp; \
  yt-dlp --version

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
