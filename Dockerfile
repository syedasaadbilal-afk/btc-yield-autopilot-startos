FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
RUN npm install && npm install --no-save ts-node@10
RUN npm run build --workspace packages/dashboard
RUN mkdir -p packages/daemon/public && cp -r packages/dashboard/dist/* packages/daemon/public/
WORKDIR /app/packages/daemon
ENV NODE_ENV=production
ENV AUTOPILOT_DB_PATH=/data/autopilot.sqlite
ENV DASHBOARD_PORT=8787
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "--experimental-sqlite", "--loader", "ts-node/esm", "src/index.ts"]
