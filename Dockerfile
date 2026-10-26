FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts
COPY server ./server
COPY web ./web
USER node
EXPOSE 8080
CMD ["node", "server/index.mjs"]
