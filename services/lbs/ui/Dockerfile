FROM node:20-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# RUN npm run build # We can use dev for now or build for production

EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
