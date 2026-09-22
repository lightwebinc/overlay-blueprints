.PHONY: build check test clean image

build:
	npm ci && npm run build

check:
	npm run check

test: build
	npm test

image:
	docker build -t overlay-blueprints:dev .

clean:
	rm -rf dist
