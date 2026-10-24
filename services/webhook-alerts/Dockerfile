FROM oven/bun:1.4.4-alpine
LABEL org.opencontainers.image.source="https://github.com/Cringe-Driven-Development-Team/.github"
RUN apk add --no-cache wget
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN mkdir -p /data/snapshots && chmod 700 /data/snapshots && chown bun:bun /data /data/snapshots
USER bun
EXPOSE 8080
CMD ["bun", "run", "src/main.ts"]
