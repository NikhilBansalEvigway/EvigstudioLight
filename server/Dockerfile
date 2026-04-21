FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY scripts/ ./scripts/
COPY drizzle/ ./drizzle/

EXPOSE 3001

CMD ["node", "dist/index.js"]
