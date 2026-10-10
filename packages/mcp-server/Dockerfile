# Open Archiver MCP server: ghcr.io/wispborne/open-archiver-mcp
#
# Build from the repository root:
#   docker build -f packages/mcp-server/Dockerfile -t open-archiver-mcp .
#
# Runs the Streamable HTTP transport by default. For stdio (a client config that starts the
# container itself), pass `stdio`:
#   docker run -i --rm -e OPEN_ARCHIVER_URL -e OPEN_ARCHIVER_API_KEY ghcr.io/wispborne/open-archiver-mcp stdio

FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable

# Only the MCP server and the types it imports. The bundle inlines every runtime dependency, and
# the types are compile-time only, so nothing else of the monorepo is installed or built.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/types/package.json packages/types/
COPY packages/mcp-server/package.json packages/mcp-server/
RUN pnpm install --frozen-lockfile --filter @open-archiver/mcp-server...

COPY packages/types packages/types
COPY packages/mcp-server packages/mcp-server
RUN pnpm --filter @open-archiver/mcp-server build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /src/packages/mcp-server/dist/index.js ./index.js

# Inside a container the server has to listen on all interfaces to be reachable from the Docker
# network. Host header validation still applies, against MCP_ALLOWED_HOSTS; the default names
# the compose service, so other containers can reach it as http://mcp:3333/mcp.
ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3333 \
    MCP_ALLOWED_HOSTS=mcp,open-archiver-mcp,localhost,127.0.0.1

USER node
EXPOSE 3333
ENTRYPOINT ["node", "/app/index.js"]
CMD ["http"]
