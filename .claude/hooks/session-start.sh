#!/bin/bash
# Prepares a Claude Code cloud session: installs dependencies, builds the shared types package and
# starts Postgres and Redis. See "Commands" and "Known environment quirks" in CLAUDE.md.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
	exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# --- Dependencies -------------------------------------------------------------------------------
# The backend pulls xlsx from cdn.sheetjs.com, which the sandbox proxy can refuse (403). When the
# frozen install fails, install once with xlsx pinned to the npm registry release, then put
# package.json and pnpm-lock.yaml back exactly as they were: that override must never be committed.
if ! pnpm install --frozen-lockfile; then
	echo "Frozen install failed; retrying with the local-only xlsx override." >&2
	backup="$(mktemp -d)"
	cp package.json pnpm-lock.yaml "$backup/"
	restore() {
		cp "$backup/package.json" "$backup/pnpm-lock.yaml" .
		rm -rf "$backup"
	}
	trap restore EXIT
	node -e '
		const fs = require("fs");
		const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
		p.pnpm = p.pnpm || {};
		p.pnpm.overrides = { ...(p.pnpm.overrides || {}), xlsx: "0.18.5" };
		fs.writeFileSync("package.json", JSON.stringify(p, null, "\t") + "\n");
	'
	pnpm install --no-frozen-lockfile
	restore
	trap - EXIT
fi

# Backend and frontend import @open-archiver/types from its dist folder. The package is a composite
# (incremental) build: with dist gone but tsconfig.tsbuildinfo left behind, tsc decides nothing
# changed and emits nothing, so drop the stale build info first.
[ -f packages/types/dist/index.js ] || rm -f packages/types/tsconfig.tsbuildinfo
pnpm --filter @open-archiver/types build

# --- Services -----------------------------------------------------------------------------------
# Best effort: a session that only edits code should still start if a service will not.

if command -v pg_ctlcluster >/dev/null 2>&1; then
	service postgresql start >/dev/null 2>&1 || echo "Could not start Postgres." >&2
	# A superuser and database for local runs, matching the DATABASE_URL in CLAUDE.md.
	su postgres -c "psql -tAc \"select 1 from pg_roles where rolname='oa'\"" 2>/dev/null | grep -q 1 ||
		su postgres -c "psql -qc \"create user oa with password 'oa' superuser\"" >/dev/null 2>&1 || true
	su postgres -c "psql -tAc \"select 1 from pg_database where datname='oa'\"" 2>/dev/null | grep -q 1 ||
		su postgres -c "psql -qc \"create database oa owner oa\"" >/dev/null 2>&1 || true
fi

# Snapshots off and run from /tmp: redis-server writes dump.rdb into its working directory, which
# would otherwise leave an untracked file in the repository.
if command -v redis-server >/dev/null 2>&1 && ! redis-cli ping >/dev/null 2>&1; then
	(cd /tmp && redis-server --daemonize yes --save "" --appendonly no >/dev/null) ||
		echo "Could not start Redis." >&2
fi
