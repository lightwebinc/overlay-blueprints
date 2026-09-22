.PHONY: build check test clean image licences licences-update

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

licences:
	python3 scripts/gen-third-party-licenses.py . --check

licences-update:
	python3 scripts/gen-third-party-licenses.py .
