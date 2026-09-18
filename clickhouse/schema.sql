-- net-watch history store. Applied by the collector at startup (idempotent)
-- and by the ClickHouse container on first boot.

CREATE DATABASE IF NOT EXISTS netwatch;

-- One row per (process, remote endpoint, local port) per collection interval.
CREATE TABLE IF NOT EXISTS netwatch.flows
(
    ts          DateTime64(3)          CODEC(DoubleDelta, ZSTD(1)),
    interval_ms UInt32                 CODEC(T64, ZSTD(1)),
    pid         UInt32,
    proc_start  UInt64                 COMMENT 'process start in ns since boot, with pid identifies a process instance',
    name        LowCardinality(String),
    uid         UInt32,
    proto       LowCardinality(String) COMMENT 'TCP or UDP',
    app         LowCardinality(String) COMMENT 'HTTPS, SSH, DNS, QUIC, ... or unknown',
    raddr       IPv6                   COMMENT 'IPv4 is stored IPv4-mapped (::ffff:a.b.c.d)',
    rport       UInt16,
    lport       UInt16,
    tx_bytes    UInt64                 CODEC(T64, ZSTD(1)),
    rx_bytes    UInt64                 CODEC(T64, ZSTD(1)),
    tx_calls    UInt32                 CODEC(T64, ZSTD(1)),
    rx_calls    UInt32                 CODEC(T64, ZSTD(1)),
    INDEX ts_minmax ts TYPE minmax GRANULARITY 1,
    INDEX raddr_bf raddr TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (pid, proc_start, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY;

-- Latest state of every process instance ever seen. Query with FINAL.
CREATE TABLE IF NOT EXISTS netwatch.processes
(
    pid           UInt32,
    proc_start    UInt64,
    start_ms      DateTime64(3),
    name          LowCardinality(String),
    cmdline       String CODEC(ZSTD(3)),
    uid           UInt32,
    first_seen    DateTime64(3),
    last_seen     DateTime64(3),
    ended         Nullable(DateTime64(3)),
    tx_total      UInt64,
    rx_total      UInt64,
    version       UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (pid, proc_start);

-- Per-minute rollup for cheap long-range queries, kept far longer than raw flows.
CREATE TABLE IF NOT EXISTS netwatch.flows_1m
(
    minute     DateTime,
    pid        UInt32,
    proc_start UInt64,
    name       LowCardinality(String),
    proto      LowCardinality(String),
    app        LowCardinality(String),
    raddr      IPv6,
    rport      UInt16,
    tx_bytes   UInt64,
    rx_bytes   UInt64,
    tx_calls   UInt64,
    rx_calls   UInt64
)
ENGINE = SummingMergeTree((tx_bytes, rx_bytes, tx_calls, rx_calls))
PARTITION BY toYYYYMM(minute)
ORDER BY (minute, pid, proc_start, proto, app, raddr, rport)
TTL minute + INTERVAL 2 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS netwatch.flows_1m_mv TO netwatch.flows_1m AS
SELECT
    toStartOfMinute(ts) AS minute,
    pid, proc_start, any(name) AS name, proto, app, raddr, rport,
    sum(tx_bytes) AS tx_bytes, sum(rx_bytes) AS rx_bytes,
    sum(tx_calls) AS tx_calls, sum(rx_calls) AS rx_calls
FROM netwatch.flows
GROUP BY minute, pid, proc_start, proto, app, raddr, rport;
