FROM node:20-alpine AS development-dependencies-env
COPY . /app
WORKDIR /app
RUN npm ci

FROM node:20-alpine AS production-dependencies-env
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci --omit=dev

FROM node:20-alpine AS build-env
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
WORKDIR /app
RUN npm run build

FROM node:20-alpine
COPY ./package.json package-lock.json /app/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build

# Copy drizzle-kit for migrations (needed at startup)
COPY --from=build-env /app/node_modules/drizzle-kit /app/node_modules/drizzle-kit
COPY --from=build-env /app/node_modules/drizzle-orm /app/node_modules/drizzle-orm

WORKDIR /app

EXPOSE 3001

VOLUME ["/data"]

# Run db:push to create tables, then start the app
CMD ["sh", "-c", "npm run db:push && npm run start"]
