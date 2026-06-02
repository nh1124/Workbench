FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY services/images/package.json services/images/package.json
COPY services/images/tsconfig.json services/images/tsconfig.json
COPY services/images/src services/images/src

RUN npm ci
RUN npm run build --workspace services/images


FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY services/images/package.json services/images/package.json
RUN npm ci --omit=dev --workspace services/images --include-workspace-root=false

COPY --from=builder /app/services/images/dist services/images/dist

EXPOSE 4105

CMD ["npm", "run", "start", "--workspace", "services/images"]
