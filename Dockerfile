# =============================================================================
# Produktions-Images des Tax-CMS (ADR 0001 §8, Betriebsschnittstelle Stufe 2).
#
#   docker build --target api     --build-arg TCMS_VERSION=1.2.3 -t <prefix>/tcms-api:1.2.3 .
#   docker build --target migrate -t <prefix>/tcms-migrate:1.2.3 .
#
#   api      Laufzeit des Dienstes: Node 24 Alpine, nur das gebündelte
#            JavaScript (dist/server.mjs), die Produktionsabhängigkeiten aus
#            `pnpm deploy --prod` und der erzeugte Prisma-Client. Kein pnpm,
#            npm, Corepack, tsx, esbuild, keine Prisma-CLI, keine Seeds, keine
#            Demo, keine Tests. UID/GID 10001, Root-Dateisystem schreibgeschützt
#            möglich (nichts wird geschrieben), Port 3200.
#   migrate  Kurzlebiger Schritt: psql-basierter Läufer (packages/db/betrieb),
#            Rollendatei und Migrationen auf dem PostgreSQL-18-Image, ohne Node
#            und ohne Prisma-CLI; UID/GID 70 (postgres).
#
# Basisimages per Digest gepinnt (dieselben wie in der kanzleikonsole). Ohne
# `# syntax=`-Zeile: Das eingebaute Dockerfile-Frontend von BuildKit genügt;
# `docker/dockerfile:<tag>` wäre zusätzlicher, nicht gepinnter Build-Code.
# Regeln: scripts/pruefe-dockerfile.mjs (CI).
# =============================================================================

ARG NODE_IMAGE=node:24-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2
ARG POSTGRES_IMAGE=postgres:18-alpine@sha256:96d56f7f57c6aacd1fcb908bc83b345ec5f83231ee486dd66a1baadce274db88

# ----- Build (nie ausgeliefert) ------------------------------------------------
# Basis per Digest in der ARG oben gepinnt (hadolint erkennt das nicht).
# hadolint ignore=DL3006
FROM ${NODE_IMAGE} AS bau
WORKDIR /repo
ENV CI=true
# pnpm genau in der Version aus `packageManager` (Corepack), nur in diesem Stage.
COPY package.json ./
RUN corepack enable && corepack install && pnpm --version
# Paketstore nur aus Lockfile und Workspace-Regeln (minimumReleaseAge,
# trustPolicy, blockExoticSubdeps …); eigene Schicht ohne Quelltexte.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --store-dir /pnpm-store
# Quelltexte (Positivliste in .dockerignore); keine Schreibrechte für Gruppe/Welt.
COPY . .
RUN chmod -R u=rwX,go=rX /repo
# Nur der Dienst und seine Workspace-Pakete; Install-Skripte laufen nur laut
# allowBuilds (strictDepBuilds bricht bei ungeprüften Hooks ab).
# Getrennte Schichten (Cache je Schritt); der Stage wird nie ausgeliefert.
# hadolint ignore=DL3059
RUN pnpm install --frozen-lockfile --store-dir /pnpm-store --filter @tcms/api...
# hadolint ignore=DL3059
RUN pnpm --filter @tcms/db generate
ARG TCMS_VERSION=0.0.0-dev
RUN TCMS_VERSION="${TCMS_VERSION}" pnpm --filter @tcms/api build
# Laufzeitbaum: nur Produktionsabhängigkeiten. `--no-optional` lässt die als
# optionale Peers aufgelösten Werkzeuge weg (Prisma-CLI und TypeScript an
# @prisma/client); laufzeit.mjs ergänzt den erzeugten Prisma-Client, entfernt
# die gebündelten Workspace-Kopien und bricht ab, wenn ein Werkzeug, eine
# .env oder eine externe Abhängigkeit des Bundles fehlt bzw. zu viel ist.
RUN pnpm --filter @tcms/api deploy --prod --no-optional --store-dir /pnpm-store /deploy \
 && node apps/api/scripts/laufzeit.mjs /deploy \
      --prisma-client node_modules/.prisma/client --bundle apps/api/dist \
 && mkdir -p /app/dist \
 && cp apps/api/dist/server.mjs apps/api/dist/server.mjs.map /app/dist/ \
 && cp apps/api/healthcheck.mjs /app/healthcheck.mjs \
 && mv /deploy/node_modules /app/node_modules \
 && chmod -R u=rwX,go=rX /app

# ----- tcms-api ----------------------------------------------------------------
# Basis per Digest in der ARG oben gepinnt (hadolint erkennt das nicht).
# hadolint ignore=DL3006
FROM ${NODE_IMAGE} AS api
ARG TCMS_VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="tcms-api" \
      org.opencontainers.image.description="Tax-CMS – interner Dienst der kanzleikonsole" \
      org.opencontainers.image.version="${TCMS_VERSION}"
# Keine Paketmanager im Laufzeit-Image (npm, npx, Corepack, Yarn).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && addgroup -S -g 10001 tcms \
 && adduser -S -D -H -u 10001 -G tcms -s /sbin/nologin tcms
WORKDIR /app
# Eigentümer root, lesbar für alle: Der Dienst kann seine Dateien nicht ändern.
COPY --from=bau --chown=0:0 /app /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3200
USER 10001:10001
# Laufzeit-Invarianten bereits beim Bauen unter dem echten Benutzer prüfen.
RUN set -eu; \
    test "$(id -u):$(id -g)" = "10001:10001"; \
    test -r dist/server.mjs && test -r healthcheck.mjs; \
    test ! -w dist/server.mjs && test ! -w healthcheck.mjs && test ! -w node_modules; \
    for p in tsx esbuild prisma typescript vitest @tcms .bin; do test ! -e "node_modules/$p"; done; \
    test ! -e /usr/local/bin/npm && test ! -e /usr/local/bin/corepack; \
    test -r node_modules/.prisma/client/default.js
EXPOSE 3200
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "/app/healthcheck.mjs"]
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "/app/dist/server.mjs"]

# ----- Dateien des Migrationsläufers (nie ausgeliefert) -------------------------
# Eigener Stage, damit Modi aus einem restriktiven Checkout (0600/0700) nicht im
# Image landen: alles root-eigen, lesbar für alle, nur migrate.sh ausführbar.
# Basis per Digest in der ARG oben gepinnt (hadolint erkennt das nicht).
# hadolint ignore=DL3006
FROM ${POSTGRES_IMAGE} AS migrate-dateien
COPY packages/db/betrieb /opt/tcms/betrieb
COPY packages/db/prisma/init/rollen.psql /opt/tcms/prisma/init/rollen.psql
COPY packages/db/prisma/migrations /opt/tcms/prisma/migrations
RUN chown -R 0:0 /opt/tcms \
 && chmod -R u=rwX,go=rX /opt/tcms \
 && chmod 0755 /opt/tcms/betrieb/migrate.sh

# ----- tcms-migrate ------------------------------------------------------------
# Basis per Digest in der ARG oben gepinnt (hadolint erkennt das nicht).
# hadolint ignore=DL3006
FROM ${POSTGRES_IMAGE} AS migrate
ARG TCMS_VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="tcms-migrate" \
      org.opencontainers.image.description="Tax-CMS – Bootstrap, Migrationen, Prüfung (psql)" \
      org.opencontainers.image.version="${TCMS_VERSION}"
COPY --from=migrate-dateien /opt/tcms /opt/tcms
USER 70:70
RUN set -eu; \
    test "$(id -u)" = "70"; \
    bash -n /opt/tcms/betrieb/migrate.sh; \
    cat /opt/tcms/betrieb/*.sql /opt/tcms/prisma/init/rollen.psql \
      /opt/tcms/prisma/migrations/*/migration.sql >/dev/null; \
    test ! -w /opt/tcms/betrieb/migrate.sh && test ! -w /opt/tcms/prisma/migrations; \
    psql --version; \
    test -z "$(command -v node || true)"
WORKDIR /opt/tcms
HEALTHCHECK NONE
ENTRYPOINT ["/opt/tcms/betrieb/migrate.sh"]
CMD []
