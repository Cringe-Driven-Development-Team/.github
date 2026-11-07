FROM oven/bun:1.4.4-alpine
LABEL org.opencontainers.image.source="https://github.com/Cringe-Driven-Development-Team/.github"
WORKDIR /app/services/githubbot
COPY services/githubbot/package.json services/githubbot/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY services/githubbot/src ./src
COPY services/webhook-alerts/src/format.ts /app/services/webhook-alerts/src/format.ts
RUN mkdir -p /data && chown bun:bun /data && chmod 700 /data
USER bun
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD ["bun", "run", "src/main.ts", "--health"]
CMD ["bun", "run", "src/main.ts"]
