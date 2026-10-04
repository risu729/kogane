# Source Research Records

These are dated research and implementation observations, not a catalogue of
currently enabled collectors. Authentication, feasibility, prices and provider
maintenance must be checked again before a new implementation decision. Later
appendices can supersede earlier recommendations. Use [current status](../current-status.md),
[collector runtimes](../collector-runtime-profiles.md), collector code/configs
and [schedules](../schedules.md) for current implementation and timing.
Source maintenance provenance is stored in the scheduling DB, not maintained by
copying hours into every research record.

Each file in this directory covers exactly one institution or one confirmed
shared API family. Research branches and pull requests stay separate so a
future implementation can continue from the source-specific evidence without
bringing unrelated authentication assumptions with it.

Use this outline:

1. scope and non-goals;
2. methods and date checked;
3. official surfaces and available data;
4. granularity, retention, pagination, and pending/posted behavior;
5. authentication and session lifecycle;
6. CDN, WAF, and anti-automation observations;
7. APK or other native client availability;
8. third-party implementations and licenses;
9. runtime feasibility;
10. cost score, automation level, recommendation, and next experiment;
11. confirmed facts, inferences, and unknowns;
12. source links.

Do not include credentials, cookies, account/card/member numbers, balances, or
personally identifying captures. Do not exercise transfer, trade, charge,
profile, or other write endpoints.
