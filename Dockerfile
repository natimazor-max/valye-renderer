FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY server.js ./

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
