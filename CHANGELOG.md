2026-09-16, v2026.09.16. Added engine routes for a snapshot, a ledger, a heartbeat, and a two way command queue.

2026-09-03, v2026.09.03. Added a food network news relay and a congressional trading disclosure relay. Fixed a lockfile problem that was blocking the last deploy.

2026-09-01, v2026.09.01. Added insider filing support to the SEC relay.

2026-08-30, v2026.08.30. Added a shared quote relay that stretches across visitors. Quote and history requests now batch into one call and warm the whole ticker list on open. Batches cap at the free credit limit and defer the rest.

2026-08-29, v2026.08.29. Created the backend. It started with SEC filings, economic data, tariffs, and magazine news. Added device sync and a scheduled refresh. Fixed filing numbers, feed titles, and filing links. Added futures prices for commodities with a real exchange contract.
