FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY services/wbs/package.json services/wbs/package.json
COPY services/wbs/tsconfig.json services/wbs/tsconfig.json
COPY services/wbs/src services/wbs/src

RUN npm install --workspace services/wbs --include-workspace-root=false
RUN npm run build --workspace services/wbs


FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY services/wbs/package.json services/wbs/package.json
RUN npm install --omit=dev --workspace services/wbs --include-workspace-root=false

COPY --from=builder /app/services/wbs/dist services/wbs/dist

EXPOSE 4107

CMD ["npm", "run", "start", "--workspace", "services/wbs"]
