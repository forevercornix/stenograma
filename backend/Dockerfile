# syntax=docker/dockerfile:1.7
# ^ BuildKit syntax - reikalinga RUN --mount=type=cache (npm cache tarp build'ų).
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
# Cache mount: npm cache išlieka tarp build'ų, tad pakartotiniai build'ai NEsiunčia
# tų pačių paketų iš naujo (žymiai greičiau). Reikia DOCKER_BUILDKIT=1 (numatyta
# naujose Docker versijose).
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server.js"]
