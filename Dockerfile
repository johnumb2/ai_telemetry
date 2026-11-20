# --- build stage ---
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- go build stage: hoststats (telemetry) + auths (auth) sidecars ---
FROM golang:1.21-alpine AS go-build
WORKDIR /src
# module root is the repo root (go.mod + go.sum at ./); each sidecar is
# built from its own directory.
COPY go.mod go.sum ./
RUN go mod download
COPY hoststats ./hoststats
COPY auths ./auths
RUN CGO_ENABLED=0 go build -o /out/hoststats ./hoststats
RUN CGO_ENABLED=0 go build -o /out/auths ./auths

# --- runtime stage: serve the SPA + reverse proxy /metrics + auth ---
FROM nginx:1.27-alpine

# /data holds the SQLite auth db + the local (no-SMTP) mail spool
RUN mkdir -p /data

COPY docker/entrypoint.sh /opt/pulse/entrypoint.sh
COPY docker/nginx.conf.template /opt/pulse/nginx.conf.template
COPY --from=go-build /out/hoststats /opt/pulse/hoststats
COPY --from=go-build /out/auths /opt/pulse/auths
COPY --from=build /app/dist /usr/share/nginx/html

RUN chmod +x /opt/pulse/entrypoint.sh

EXPOSE 80
CMD ["/opt/pulse/entrypoint.sh"]
