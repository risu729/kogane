# Experiment: Mizuho direct collection

| Field              | Value                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Owner              | risu729                                                                                   |
| Started            | 2026-09-13                                                                                |
| Expires            | 2026-10-13                                                                                |
| Status             | Public-entry diagnostic only; account/history parsers promoted to shared production code. |
| Question           | Which response does the public login entry return to the ordinary local HTTP client?      |
| Deployed resources | None: no Worker, bucket, database, queue, container or cron.                              |

The runnable network scope is one public GET chain per explicit invocation,
with no credentials or authenticated requests; tests use only synthetic data.
The parsers and their regression tests now live in
[`packages/parsers`](../../packages/parsers/src/parsers/mizuho-html.ts), and the
integrated collector lives in
[`services/collector-mizuho`](../../services/collector-mizuho/).
No production package or service may import this experiment.

Retire this code and preserve its findings in `docs/research/` when direct
collection has a validated runtime and replaces the diagnostic, when the
public probe no longer informs the implementation, or when the expiry date
passes. Extending the expiry requires recording a reason here.

Direct history pagination, session refresh and deployed operation need separate
validation; this public diagnostic does not satisfy those gates.
