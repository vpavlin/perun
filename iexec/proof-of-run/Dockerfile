FROM node:14-alpine3.11
WORKDIR /app
COPY ./src /app
### install your dependencies if you have some
RUN npm install && npm run build

ENTRYPOINT [ "node", "/app/index.js"]