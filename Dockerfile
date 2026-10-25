FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Build the React client into dist/, then drop dev dependencies from the image.
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# Node 24 runs the TypeScript server directly (type stripping), no compile step.
CMD ["node", "server/main.ts"]
