# --- build stage ---
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- hoststats build stage: the tiny Go telemetry sidecar (stdlib only) ---
FROM golang:1.21-alpine AS hoststats-build
WORKDIR /src
# module root is the repo root; build ./hoststats
COPY go.mod ./
COPY hoststats ./hoststats
RUN CGO_ENABLED=0 go build -o /out/hoststats ./hoststats

# --- runtime stage: serve the SPA + reverse proxy /metrics ---
FROM nginx:1.27-alpine

COPY docker/entrypoint.sh /opt/pulse/entrypoint.sh
COPY docker/nginx.conf.template /opt/pulse/nginx.conf.template
COPY --from=hoststats-build /out/hoststats /opt/pulse/hoststats
COPY --from=build /app/dist /usr/share/nginx/html

RUN chmod +x /opt/pulse/entrypoint.sh

EXPOSE 80
CMD ["/opt/pulse/entrypoint.sh"]
