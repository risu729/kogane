-- Runtime schedule configuration and public maintenance provenance; no bank values.
CREATE TABLE collection_schedules (
 id TEXT PRIMARY KEY, source TEXT, kind TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), supported INTEGER NOT NULL CHECK(supported IN(0,1)),
 timezone TEXT NOT NULL, pattern_json TEXT NOT NULL CHECK(json_valid(pattern_json)),
 revision INTEGER NOT NULL DEFAULT 1, next_nominal_at TEXT, next_run_at TEXT,
 updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
 CHECK(supported=1 OR enabled=0)
) STRICT;
CREATE TABLE collection_schedule_revisions (
 id INTEGER PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES collection_schedules(id),
 revision INTEGER NOT NULL, enabled INTEGER NOT NULL, timezone TEXT NOT NULL,
 pattern_json TEXT NOT NULL CHECK(json_valid(pattern_json)), actor TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(schedule_id,revision)
) STRICT;
CREATE TRIGGER schedule_revisions_no_update BEFORE UPDATE ON collection_schedule_revisions BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER schedule_revisions_no_delete BEFORE DELETE ON collection_schedule_revisions BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE collection_schedule_occurrences (
 id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES collection_schedules(id),
 nominal_at TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
 status TEXT NOT NULL CHECK(status IN('started','completed','failed','uncertain')),
 run_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(run_ids_json)), failure_code TEXT,
 UNIQUE(schedule_id,nominal_at)
) STRICT;
CREATE INDEX schedule_occurrences_recent ON collection_schedule_occurrences(started_at DESC);
CREATE TABLE provider_maintenance_references (
 source TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN('confirmed','no-applicable-rule','not-found')),
 reference_url TEXT NOT NULL, verified_at TEXT NOT NULL
) STRICT;
CREATE TABLE provider_maintenance_rules (
 id TEXT NOT NULL, revision INTEGER NOT NULL, source TEXT NOT NULL,
 timezone TEXT NOT NULL, pattern_json TEXT NOT NULL CHECK(json_valid(pattern_json)),
 enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), reference_url TEXT NOT NULL,
 verified_at TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN('collection','session','feature-only')),
 actor TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(id,revision)
) STRICT;
CREATE INDEX maintenance_source ON provider_maintenance_rules(source,id,revision);
CREATE TRIGGER maintenance_no_update BEFORE UPDATE ON provider_maintenance_rules BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER maintenance_no_delete BEFORE DELETE ON provider_maintenance_rules BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE collection_execution_leases (source TEXT PRIMARY KEY, lease_ref TEXT, started_at TEXT,
 CHECK((lease_ref IS NULL)=(started_at IS NULL))) STRICT;

-- Initial public research and existing execution times; activation is separate.
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('prestia-globalpass','prestia-globalpass','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"03:17","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('vpass','vpass','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"06:00","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('myjcb','myjcb','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"06:00","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('sbi-securities','sbi-securities','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"06:00","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('sbi-shinsei','sbi-shinsei','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"06:00","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('sony-bank','sony-bank','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"06:00","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('sbi-vc-trade','sbi-vc-trade','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"06:05","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('mobile-suica','mobile-suica','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"06:10","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('moneyforward-me','moneyforward-me','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"06:15","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('vpoint','vpoint','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"06:15","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('mizuho-bank','mizuho-bank','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"06:25","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('st-george','st-george','collection','1','1','Asia/Tokyo','{"kind":"daily","time":"06:35","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('sbi-vc-keepalive','sbi-vc-trade','keepalive','1','1','UTC','{"kind":"interval","minutes":15}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('processor-tick',NULL,'processor','1','1','UTC','{"kind":"interval","minutes":5}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('smbc-direct','smbc-direct','manual','0','0','Asia/Tokyo','{"kind":"daily","time":"06:00","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by) VALUES('vpoint-pay','vpoint-pay','email','0','0','Asia/Tokyo','{"kind":"daily","time":"06:00","weekdays":[0,1,2,3,4,5,6]}','2026-10-04T14:40:00.000Z','migration:0065');
INSERT INTO collection_schedule_revisions(schedule_id,revision,enabled,timezone,pattern_json,actor,created_at) SELECT id,revision,enabled,timezone,pattern_json,updated_by,updated_at FROM collection_schedules;
INSERT INTO provider_maintenance_references VALUES('prestia-globalpass','confirmed','https://www.debit.vpass.ne.jp/p/login/RW1312010001?cc=01006','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('vpass','confirmed','https://www.smbc-card.com/mem/index.jsp','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('myjcb','confirmed','https://www.jcb.co.jp/jcb_mente/mente_service.html','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('sbi-securities','confirmed','https://search.sbisec.co.jp/v2/popwin/info/home/pop6040_maintenance.html','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('sbi-shinsei','no-applicable-rule','https://www.sbishinseibank.co.jp/news/news22.html','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('sony-bank','confirmed','https://sonybank.jp/guide/hours.html','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('sbi-vc-trade','confirmed','https://www.sbivc.co.jp/assets/docs/manual_tt.pdf','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('mobile-suica','confirmed','https://www.jreast.co.jp/mobilesuica/use/sf/chk_account.html','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('moneyforward-me','not-found','https://support.me.moneyforward.com/hc/ja','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('vpoint','not-found','https://t-point.tsite.jp/get/service/vrank/','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('st-george','not-found','https://www.stgeorge.com.au/online-services/internet-banking','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('mizuho-bank','confirmed','https://www.mizuhobank.co.jp/direct/time.html','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('smbc-direct','confirmed','https://www.smbc.co.jp/kojin/direct/jikan/','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_references VALUES('vpoint-pay','not-found','https://www.smbc-card.com/prepaid/vpoint/index.jsp','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('globalpass-members','1','prestia-globalpass','Asia/Tokyo','{"kind":"monthly","weekday":6,"nth":3,"offsetDays":1,"start":"01:00","end":"05:00"}','1','https://www.debit.vpass.ne.jp/p/login/RW1312010001?cc=01006','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('vpass-weekly','1','vpass','Asia/Tokyo','{"kind":"weekly","weekdays":[1],"start":"00:00","end":"08:00"}','1','https://www.smbc-card.com/mem/index.jsp','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('sony-login','1','sony-bank','Asia/Tokyo','{"kind":"monthly","weekday":1,"nth":2,"offsetDays":0,"start":"00:00","end":"05:00"}','1','https://sonybank.jp/guide/hours.html','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('sony-wallet','1','sony-bank','Asia/Tokyo','{"kind":"monthly","weekday":6,"nth":3,"offsetDays":1,"start":"01:00","end":"05:00"}','1','https://sonybank.jp/guide/hours.html','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('mizuho-weekly','1','mizuho-bank','Asia/Tokyo','{"kind":"weekly","weekdays":[6],"start":"22:00","end":"08:00"}','1','https://www.mizuhobank.co.jp/direct/time.html','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('suica-night','1','mobile-suica','Asia/Tokyo','{"kind":"weekly","weekdays":[0,1,2,3,4,5,6],"start":"00:50","end":"05:00"}','1','https://www.jreast.co.jp/mobilesuica/use/sf/chk_account.html','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('sbi-weekly','1','sbi-securities','Asia/Tokyo','{"kind":"weekly","weekdays":[0],"start":"13:00","end":"18:00"}','1','https://search.sbisec.co.jp/v2/popwin/info/home/pop6040_maintenance.html','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('sbi-20261010','1','sbi-securities','Asia/Tokyo','{"kind":"once","to":"2026-10-11T21:00:00.000Z","from":"2026-10-09T21:00:00.000Z"}','1','https://search.sbisec.co.jp/v2/popwin/info/home/pop6040_maintenance.html','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('myjcb-payment-20261015','1','myjcb','Asia/Tokyo','{"kind":"once","to":"2026-10-16T00:00:00.000Z","from":"2026-10-15T10:50:00.000Z"}','1','https://www.jcb.co.jp/jcb_mente/mente_service.html','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('myjcb-points-20261006','1','myjcb','Asia/Tokyo','{"kind":"once","to":"2026-10-06T23:10:00.000Z","from":"2026-10-06T14:50:00.000Z"}','1','https://www.jcb.co.jp/jcb_mente/mente_service.html','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('myjcb-points-20261020','1','myjcb','Asia/Tokyo','{"kind":"once","to":"2026-10-21T04:00:00.000Z","from":"2026-10-20T14:50:00.000Z"}','1','https://www.jcb.co.jp/jcb_mente/mente_service.html','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('sbi-vc-weekly','1','sbi-vc-trade','Asia/Tokyo','{"kind":"weekly","weekdays":[3],"start":"12:00","end":"13:00"}','1','https://www.sbivc.co.jp/assets/docs/manual_tt.pdf','2026-10-04T14:40:00.000Z','session','migration:0065','2026-10-04T14:40:00.000Z');
INSERT INTO provider_maintenance_rules VALUES('smbc-weekly','1','smbc-direct','Asia/Tokyo','{"kind":"weekly","weekdays":[0],"start":"21:00","end":"07:00"}','1','https://www.smbc.co.jp/kojin/direct/jikan/','2026-10-04T14:40:00.000Z','feature-only','migration:0065','2026-10-04T14:40:00.000Z');

-- Only genuinely pending receipts participate in the abandonment scan.
CREATE INDEX schedule_occurrences_pending ON collection_schedule_occurrences(started_at) WHERE status='started';
CREATE TRIGGER schedule_occurrence_identity_immutable BEFORE UPDATE ON collection_schedule_occurrences
WHEN NEW.id IS NOT OLD.id OR NEW.schedule_id IS NOT OLD.schedule_id OR NEW.nominal_at IS NOT OLD.nominal_at OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT,'immutable_occurrence_identity'); END;

INSERT INTO provider_maintenance_rules VALUES('sbi-account-daily','1','sbi-securities','Asia/Tokyo','{"kind":"weekly","weekdays":[0,1,2,3,4,5,6],"start":"19:00","end":"19:30"}','1','https://search.sbisec.co.jp/v2/popwin/info/home/pop6040_maintenance.html','2026-10-04T14:40:00.000Z','collection','migration:0065','2026-10-04T14:40:00.000Z');
