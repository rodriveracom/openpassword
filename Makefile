.PHONY: help setup dev verify build start package checksum backup-test installer-test
help:
	@echo "make setup     Install dependencies and compile the public packages"
	@echo "make dev       Start the local console and broker"
	@echo "make verify    Compile packages, check types, run tests and build Next.js"
	@echo "make build     Build the production console and packages"
	@echo "make start     Run the production console and broker"
	@echo "make package COMMIT=<sha>  Build that exact commit and archive it into dist-release/"
	@echo "make checksum  Write the .sha256 sidecar for the archive"
	@echo "make backup-test  Test the backup and restore scripts (Linux, needs borg)"
setup:
	npm ci
	npm run packages
dev:
	npm run dev
verify:
	npm run verify
build:
	npm run packages
	npm run build
start:
	npm start
package:
	@test -n "$(COMMIT)" || { echo "usage: make package COMMIT=<sha>" >&2; exit 2; }
	bash scripts/package.sh "$(COMMIT)"
checksum:
	bash scripts/checksum.sh
backup-test:
	bash scripts/backup-test.sh
installer-test:
	bash scripts/installer-test.sh
