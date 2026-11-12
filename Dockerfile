# Runs AgentPay402 MCP as a stdio MCP server (used by Glama's build check and
# by anyone who prefers a container). dist/ is the committed tsc output.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY dist ./dist
COPY LICENSE README.md server.json ./
# Without a wallet the server still lists all tools and runs the discovery and
# checking ones; set WALLET_PROVIDER and the provider keys to pay.
ENV WALLET_PROVIDER=none
ENTRYPOINT ["node", "dist/index.js"]
