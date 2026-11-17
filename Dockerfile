# Open Dental app gateway (TrueNAS SCALE / Docker). Published as ghcr.io/mullet156/opendental-claude.
#
# It runs gateway/runner.js, which starts the gateway with the settings in /config and,
# once a day, installs newer regular releases from GitHub (checked, with automatic
# rollback). Set AUTO_UPDATE=off to stay on the version in the image.
#
#   docker run --rm -v /srv/odgw:/config ghcr.io/mullet156/opendental-claude node gateway/cli.js init /config --stage design
#   docker run -d --name odgw --network host --restart unless-stopped -v /srv/odgw:/config ghcr.io/mullet156/opendental-claude
#
# /config holds gateway.config.json, .env (Open Dental address and keys) and logs/.
# See docs/truenas.md.
FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/MULLET156/opendental-claude" \
      org.opencontainers.image.description="Open Dental app gateway for TDC Office (built-ins only, self-updating)" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY package.json LICENSE ./
COPY core ./core
COPY gateway ./gateway
RUN rm -rf gateway/demo gateway/windows
ENV NODE_ENV=production AUTO_UPDATE=on UPDATE_HOUR=3
USER node
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "gateway/runner.js", "/config"]
