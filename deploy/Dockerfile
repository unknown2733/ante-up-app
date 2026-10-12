FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN node scripts/install-dependencies.mjs && npm --prefix clients/chain run build
ENV VITE_API_BASE_URL=/api VITE_ALLOW_FIXTURE_API=false VITE_WALLET_CLUSTER=devnet VITE_SOLANA_RPC_URL=https://api.devnet.solana.com VITE_MWA_APP_URI=https://ante-up.fun
RUN npm --prefix apps/web run build
USER node
