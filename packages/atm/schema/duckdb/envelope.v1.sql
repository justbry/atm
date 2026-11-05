-- Generated from schema/envelope.v1.json by `bun schema/build.ts`. Do not edit.
CREATE TABLE IF NOT EXISTS events (
	v INTEGER NOT NULL,
	id VARCHAR NOT NULL,
	school VARCHAR NOT NULL,
	source VARCHAR NOT NULL,
	event_type VARCHAR NOT NULL,
	event_time TIMESTAMPTZ NOT NULL,
	ingest_time TIMESTAMPTZ NOT NULL,
	date DATE NOT NULL,
	tz VARCHAR NOT NULL,
	key VARCHAR NOT NULL,
	labels MAP(VARCHAR, VARCHAR) NOT NULL,
	idem VARCHAR NOT NULL,
	cause VARCHAR,
	text VARCHAR NOT NULL,
	postings STRUCT(account VARCHAR, amount DECIMAL(18,2), commodity VARCHAR)[] NOT NULL,
	payload JSON NOT NULL,
	redacted JSON
);

-- One row per posting, the shape the parity query reads.
CREATE OR REPLACE VIEW ledger_postings AS
SELECT e.id, e.school, e.event_type, e.event_time, e.date, e.key, e.labels,
       t.p.account AS account, t.p.amount AS amount, t.p.commodity AS commodity
FROM events e, UNNEST(e.postings) AS t(p);
