# extshare server: single bundled file on the Bun runtime.
FROM oven/bun:1.3 AS build
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun build packages/server/src/main.ts --target bun --outdir /out \
 && bun build packages/server/src/admin.ts --target bun --outdir /out

FROM oven/bun:1.3-slim
WORKDIR /app
COPY --from=build /out/main.js /out/admin.js ./
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=8787
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "main.js"]
