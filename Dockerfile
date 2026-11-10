FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/showcase.db \
    API_TOKEN=nxs_demo_local

RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "src/server.js"]
