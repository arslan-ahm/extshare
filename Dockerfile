# extshare server image, built from a source checkout: docker build -t extshare .
# (Without a checkout: docker build -t extshare https://extshare.vercel.app/download/Dockerfile)
FROM oven/bun:1.3 AS build
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun build packages/server/src/bin.ts --target bun --minify --outfile /out/extshare-server.js

FROM oven/bun:1.3-slim
WORKDIR /app
COPY --from=build /out/extshare-server.js ./
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=8787
RUN mkdir -p /data && chown bun:bun /data \
 && printf '#!/bin/sh\nexec bun /app/extshare-server.js "$@"\n' > /usr/local/bin/extshare-server \
 && chmod 755 /usr/local/bin/extshare-server
USER bun
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["extshare-server"]
