# Open Dental app gateway
#   docker build -t opendental-gateway .
#   docker run -d --name odgw -p 8787:8787 \
#     -e OD_DEVELOPER_KEY=... -e OD_CUSTOMER_KEY=... -e OD_BASE_URL=https://api.opendental.com/api/v1 \
#     -v /srv/odgw:/config opendental-gateway
# /config must contain gateway.config.json (with "listen": {"host": "0.0.0.0"}); audit logs are written beside it.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY core ./core
COPY gateway ./gateway
USER node
EXPOSE 8787
CMD ["node", "gateway/server.js", "/config/gateway.config.json"]
