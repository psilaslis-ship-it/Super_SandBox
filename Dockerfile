FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 APP_PORT=8081 DATA_DIR=/data PUBLIC_BASE_DOMAIN=localhost PUBLIC_HOST=localhost PUBLIC_SCHEME=http
EXPOSE 8080 8081
VOLUME ["/data"]
USER node
CMD ["node", "src/server.js"]
