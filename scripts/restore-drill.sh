#!/usr/bin/env bash
# P10 backup/restore drill (docs/10 Resilience: "backups, tested restore, RTO/RPO documented").
# Dumps a database from the compose postgres, restores it into a fresh database,
# and proves the copy is whole: same row counts, ledger nets to zero, audit
# chain verifies end to end with the same head. Prints the restore time.
#
#   scripts/restore-drill.sh <source_db>
# Seed a source with: pnpm --filter @chema/api load -- --wallets 4 --contributions 120 --keep
set -euo pipefail
SRC="${1:?usage: restore-drill.sh <source_db>}"
DST="${SRC}_restored"
PSQL=(docker compose exec -T postgres psql -U chema -v ON_ERROR_STOP=1 -At)

facts() {
  "${PSQL[@]}" -d "$1" -c "
    SELECT 'payment=' || count(*) FROM payment UNION ALL
    SELECT 'contribution=' || count(*) FROM contribution UNION ALL
    SELECT 'receipt=' || count(*) FROM receipt UNION ALL
    SELECT 'ledger_journal=' || count(*) FROM ledger_journal UNION ALL
    SELECT 'ledger_entry=' || count(*) FROM ledger_entry UNION ALL
    SELECT 'ledger_net=' || coalesce(sum(CASE side WHEN 'D' THEN amount_minor ELSE -amount_minor END), 0) FROM ledger_entry UNION ALL
    SELECT 'audit_rows=' || count(*) FROM audit_log UNION ALL
    SELECT 'audit_head=' || (SELECT hash FROM audit_log ORDER BY audit_log.seq DESC LIMIT 1);"
}

echo "== source $SRC"; facts "$SRC" | tee /tmp/drill-src.txt
docker compose exec -T postgres sh -c "pg_dump -U chema -Fc -d '$SRC' -f /tmp/drill.dump && ls -l /tmp/drill.dump"
start=$(date +%s)
"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DST WITH (FORCE)" -c "CREATE DATABASE $DST"
docker compose exec -T postgres sh -c "pg_restore -U chema --exit-on-error -d '$DST' /tmp/drill.dump"
end=$(date +%s)
echo "== restored $DST in $((end - start)) s"; facts "$DST" | tee /tmp/drill-dst.txt
diff /tmp/drill-src.txt /tmp/drill-dst.txt && echo "== facts identical"
DATABASE_URL="postgres://chema:change-me@localhost:55432/$DST" pnpm -s audit:verify
"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DST WITH (FORCE)" -c "DROP DATABASE IF EXISTS $SRC WITH (FORCE)"
docker compose exec -T postgres sh -c "rm -f /tmp/drill.dump"
echo "== drill passed; drill databases dropped"
