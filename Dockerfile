# syntax=docker/dockerfile:1

# Digest-pinned, as every image in the fleet is: a floating tag makes the
# thing that was built unreproducible, and this host verifies transactions.
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /src/dist ./dist

# Unprivileged. The image ships no configuration: every value arrives from the
# environment, and the secrets among them from an EnvironmentFile on the host.
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
