# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# Digest-pinned, as every image in the fleet is: a floating tag makes the
# thing that was built unreproducible, and this host verifies transactions.
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /src
# The engine is a vendored fork (vendor/overlay-fork), a file: dependency, so
# the tarball has to be in the tree before npm ci reads the lock.
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /src/dist ./dist

# The licences travel with the image, not only with the source tree. Several of
# the production dependencies are licensed on terms that require their own text
# to be included in any copy or substantial portion of the software, and an
# image is exactly that: three Open BSV v6 packages and the MIT ones beside
# them. node_modules happens to carry each package's own file; these are ours,
# and LICENSE-THIRD-PARTY states the whole set in one place.
COPY LICENSE NOTICE LICENSE-THIRD-PARTY /usr/share/doc/overlay-blueprints/

# Unprivileged. The image ships no configuration: every value arrives from the
# environment, and the secrets among them from an EnvironmentFile on the host.
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
