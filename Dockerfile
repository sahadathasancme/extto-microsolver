FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV CHROME_PATH=/usr/bin/chromium NODE_ENV=production
EXPOSE 8191
CMD ["node", "server.js"]
