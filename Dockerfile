FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++ git tini

COPY package.json ./
# Versiones fijadas a propósito. Con @latest, un rebuild puede traer otra
# versión del protocolo de WhatsApp e invalidar la sesión ya vinculada.
RUN npm install --omit=dev --no-audit --no-fund

COPY main.js ./
COPY src ./src
COPY healthcheck.js ./

RUN mkdir -p /app/auth /app/data

ENV NODE_ENV=production
# tini como PID 1: así SIGTERM llega de verdad y el bot guarda antes de morir
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "main.js"]
