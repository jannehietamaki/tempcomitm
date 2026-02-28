# Stage 1: Build TypeScript
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ src/
COPY tsconfig.json .

RUN npx tsc

# Stage 2: Production image
FROM node:22-alpine

WORKDIR /app

COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY src/web/index.html dist/web/index.html

RUN mkdir -p state logs

EXPOSE 80 443 3000

CMD ["node", "dist/index.js"]
