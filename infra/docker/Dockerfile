FROM node:20-slim

# Python for tools
RUN apt-get update && apt-get install -y python3 python3-pip curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps
COPY package.json ./
RUN npm install --production

# Copy all files
COPY . .

# Build frontend
RUN cd app/frontend && npm install && npm run build && cd /app

# Bootstrap dirs
RUN mkdir -p workspace/jobs memory logs tmp uploads/images uploads/zips uploads/files uploads/raw \
    && echo '{}' > memory/short_term.json \
    && echo '{}' > memory/long_term.json \
    && echo '[]' > memory/event_log.json \
    && echo '[]' > memory/agent_history.json

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "app/backend/server.js"]
