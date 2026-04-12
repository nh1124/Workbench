FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY services/artifacts/package.json services/artifacts/package.json
COPY services/artifacts/tsconfig.json services/artifacts/tsconfig.json
COPY services/artifacts/src services/artifacts/src

RUN npm ci
RUN npm run build --workspace services/artifacts


FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV ARTIFACTS_OFFICE_CONVERTER_CMD=/usr/bin/soffice

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-core \
    libreoffice-writer \
    libreoffice-common \
    fonts-noto-cjk \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY services/artifacts/package.json services/artifacts/package.json
RUN npm ci --omit=dev --workspace services/artifacts --include-workspace-root=false

COPY --from=builder /app/services/artifacts/dist services/artifacts/dist

EXPOSE 4102

CMD ["npm", "run", "start", "--workspace", "services/artifacts"]
