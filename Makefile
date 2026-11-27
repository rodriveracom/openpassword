.PHONY: help setup dev verify build start package checksum backup-test backup-age-test backup-age-systemd-test
help:
	@echo "make setup     Install dependencies and compile the public packages"
	@echo "make dev       Start the local console and broker"
	@echo "make verify    Compile packages, check types, run tests and build Next.js"
	@echo "make build     Build the production console and packages"
	@echo "make start     Run the production console and broker"
	@echo "make package COMMIT=<sha>  Build that exact commit and archive it into dist-release/"
	@echo "make checksum  Write the .sha256 sidecar for the archive"
	@echo "make backup-test  Test the backup and restore scripts (Linux, needs borg)"
	@echo "make backup-age-test  Test the operator-held-key encrypted backup (Linux, needs age)"
	@echo "make backup-age-systemd-test  Test its root and systemd path (root, staging host, needs age)"
setup:
	sh scripts/build-engines.sh
	npm ci
	npm run packages
dev:
	npm run dev
verify:
	sh scripts/build-engines.sh
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

.PHONY: install-cli
install-cli: packages/cli/dist/index.js
	mkdir -p "$(HOME)/.local/bin"
	chmod +x packages/cli/dist/index.js
	ln -sfn "$(CURDIR)/packages/cli/dist/index.js" "$(HOME)/.local/bin/openpassword"
backup-test:
	bash scripts/backup-test.sh
backup-age-test:
	bash scripts/backup-age-test.sh
backup-age-systemd-test:
	bash scripts/backup-age-systemd-test.sh
