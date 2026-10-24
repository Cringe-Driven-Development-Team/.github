FROM oven/bun:1.4.4-alpine
RUN apk add --no-cache wget
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8080
CMD ["bun", "run", "src/main.ts"]
