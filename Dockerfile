# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage — only here to install production dependencies. The runtime image
# has no package manager, so npm never ships to production. That alone removes
# the largest source of scanner findings: npm's own dependency tree.
# ---------------------------------------------------------------------------
FROM node:26-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# The runtime has no shell, so /data cannot be created with RUN mkdir there.
# Stage an empty directory with the right ownership and copy it across.
RUN mkdir -p /empty-data && chown 65532:65532 /empty-data

# ---------------------------------------------------------------------------
# Runtime — Chainguard.
#
# Minimal, non-root (uid 65532), and maintained at zero known CVEs. Measured
# against the alternatives for this app:
#
#   node:24-alpine       1C 6H 9M   240 pkgs   node 24.19.0
#   distroless nodejs24  0C 2H 5M    86 pkgs   node 24.14.0  (runtime lags)
#   chainguard node      0C 0H 0M              node 26.7.0
#
# The trade-off: the free tier publishes only a moving `:latest`, so a future
# Node major arrives unattended. This app's entire storage layer rests on
# `node:sqlite`, which is still experimental and may change across majors, so
# the CI workflow boots the built image and exercises node:sqlite and the HTTP
# surface before publishing. A breaking bump fails the build rather than the
# deployment.
#
# There are no native modules to compile, which is what makes a minimal runtime
# viable at all.
# ---------------------------------------------------------------------------
FROM cgr.dev/chainguard/node:latest

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

COPY --from=deps --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 package.json ./
COPY --chown=65532:65532 server ./server
COPY --chown=65532:65532 public ./public

# Owned by the runtime user so the database, cached media and backups are
# writable. A named volume inherits this ownership; a bind-mounted host
# directory does not — see the README.
COPY --from=deps --chown=65532:65532 /empty-data /data

USER 65532:65532
VOLUME ["/data"]
EXPOSE 8080

# Exec form: there is no shell to parse a string command.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/usr/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The base image's entrypoint is already node, so this is just its arguments.
CMD ["server/index.js"]
