FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 APP_PORT=8081 DATA_DIR=/data PUBLIC_BASE_DOMAIN=localhost PUBLIC_HOST=localhost PUBLIC_SCHEME=http MAX_JSON_MB=512 MAX_DATABASES=20 MAX_APPS=20
EXPOSE 8080 8081
VOLUME ["/data"]
USER node
CMD ["node", "src/server.js"]
