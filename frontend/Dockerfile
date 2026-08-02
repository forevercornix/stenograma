# syntax=docker/dockerfile:1.7
# --- Build stage ---
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY . .

# VITE_* kintamieji įkompiliuojami į bundle'ą BUILD metu. NUMATYTA: VITE_BACKEND_URL
# TUŠČIAS -> frontend naudoja SANTYKINĮ "/api" (nginx proxy). Tai daro image
# UNIVERSALŲ bet kuriam domenui - nereikia perbuildinti kiekvienai aplinkai.
# Jei vis dėlto reikia absoliutaus URL (frontend ir backend atskiruose hostuose
# be proxy), perduokite VITE_BACKEND_URL per build-arg.
ARG VITE_BACKEND_URL=
ARG VITE_API_KEY=
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_API_KEY=$VITE_API_KEY

RUN npm run build

# --- Serve stage ---
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html

# nginx.conf su ${BACKEND_HOST}/${BACKEND_PORT} - įdedam kaip TEMPLATE. nginx:alpine
# automatiškai per envsubst pakeičia aplinkos kintamuosius /etc/nginx/templates/*.template
# failuose ir rezultatą įrašo į /etc/nginx/conf.d/ paleidimo metu.
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Numatytas backend adresas (Docker Compose serviso vardas). Perrašomas per
# environment docker-compose faile, jei reikia kito hosto/porto.
ENV BACKEND_HOST=backend
ENV BACKEND_PORT=3001
# envsubst keičia TIK BACKEND_* kintamuosius (ne nginx $host, $remote_addr ir pan.)
ENV NGINX_ENVSUBST_FILTER="BACKEND_"

EXPOSE 80
