FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p logs

EXPOSE 8001

CMD ["node", "src/index.js"]
