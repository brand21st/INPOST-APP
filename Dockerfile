FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --no-audit --no-fund && npm cache clean --force

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

CMD ["npm", "run", "docker-start"]
