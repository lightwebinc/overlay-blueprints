# syntax=docker/dockerfile:1.29.0@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

# Digest-pinned, as every image in the fleet is: a floating tag makes the
# thing that was built unreproducible, and this host verifies transactions.
FROM node@sha256:f8e5d4bb28fa55c74f1345166a082a10b7c68f22304350c1ce0d18358ae94996 AS build
WORKDIR /src
# The engine is a vendored fork (vendor/overlay-fork), a file: dependency, so
# the tarball has to be in the tree before npm ci reads the lock.
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node@sha256:f8e5d4bb28fa55c74f1345166a082a10b7c68f22304350c1ce0d18358ae94996
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /src/dist ./dist

# The licenses travel with the image, not only with the source tree. Several of
# the production dependencies are licensed on terms that require their own text
# to be included in any copy or substantial portion of the software, and an
# image is exactly that: three Apache-2.0 BSV packages (with Open BSV exceptions) and the MIT ones beside
# them. node_modules happens to carry each package's own file; these are ours,
# and LICENSE-THIRD-PARTY states the whole set in one place.
COPY LICENSE NOTICE LICENSE-THIRD-PARTY /usr/share/doc/overlay-blueprints/

# Unprivileged. The image ships no configuration: every value arrives from the
# environment, and the secrets among them from an EnvironmentFile on the host.
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
