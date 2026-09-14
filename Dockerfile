FROM node:20-alpine

WORKDIR /app

# tzdata: sin ella la variable TZ no surte efecto en Alpine y la hora
# del sistema queda en UTC, que despista al depurar.
RUN apk add --no-cache python3 make g++ git tini tzdata

COPY package.json ./
# Versiones FIJADAS a las que ya funcionaban en producción. El Dockerfile
# anterior usaba @latest, así que cada rebuild podía cambiar de versión de
# protocolo y invalidar la sesión de WhatsApp.
RUN npm install --omit=dev --no-audit --no-fund

COPY main.js ./
COPY src ./src
COPY healthcheck.js anunciar.js horario-export.js ./

RUN mkdir -p /app/auth /app/data

ENV NODE_ENV=production
# tini como PID 1: así SIGTERM llega de verdad y el bot guarda antes de morir
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "main.js"]
