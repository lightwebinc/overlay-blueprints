.PHONY: build check test clean image licences licences-update lab

build:
	npm ci && npm run build

check:
	npm run check

test: build
	npm test

# The lab-style check: needs Docker. MODULES names a directory of module
# checkouts whose bundles are built (see scripts/lab.mjs).
lab: build
	node scripts/lab.mjs $(if $(MODULES),--modules $(MODULES))

image:
	docker build -t overlay-blueprints:dev .

clean:
	rm -rf dist

licences:
	python3 scripts/gen-third-party-licenses.py . --check

licences-update:
	python3 scripts/gen-third-party-licenses.py .
