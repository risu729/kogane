# Experiment: Mizuho direct collection

| Field              | Value                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Owner              | risu729                                                                                                            |
| Started            | 2026-09-13                                                                                                         |
| Expires            | 2026-10-13                                                                                                         |
| Status             | Local HTTP account-list read verified; offline account/history parser experiment.                                  |
| Question           | Can a browser-established session support direct reads, and can observed ordinary-deposit HTML be parsed reliably? |
| Deployed resources | None: no Worker, bucket, database, queue, container or cron.                                                       |

The runnable network scope is one public GET chain per explicit invocation,
with no credentials or authenticated requests. Offline parsers accept observed
page structures in memory; tests use only synthetic data. A separate private
local test verified one authenticated account-list read with a browser session.
No production package or service may import this experiment.

Retire this code and preserve its findings in `docs/research/` when direct
collection has a validated runtime and replaces the diagnostic, when the
public probe no longer informs the implementation, or when the expiry date
passes. Extending the expiry requires recording a reason here.

Direct history pagination, session refresh and production integration need
separate validation; one local account-list read does not satisfy those gates.
