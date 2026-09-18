//! Historical store: every interval's flows plus process state go to ClickHouse
//! in RowBinary batches. Rows are buffered in memory while ClickHouse is
//! unavailable and flushed once it is back.

use std::{net::Ipv6Addr, sync::Arc, time::Duration};

use clickhouse::{Client, Row};
use serde::Serialize;
use tokio::{sync::mpsc::UnboundedReceiver, time::Instant};

use crate::model::Tick;

const SCHEMA: &str = include_str!("../../clickhouse/schema.sql");

pub struct Config {
    pub url: String,
    pub user: String,
    pub password: String,
    pub flush_every: Duration,
    /// Oldest buffered rows are discarded beyond this while ClickHouse is down.
    pub max_buffered_rows: usize,
}

#[derive(Row, Serialize)]
struct FlowRow {
    ts: i64,
    interval_ms: u32,
    pid: u32,
    proc_start: u64,
    name: String,
    uid: u32,
    proto: &'static str,
    app: &'static str,
    raddr: Ipv6Addr,
    rport: u16,
    lport: u16,
    tx_bytes: u64,
    rx_bytes: u64,
    tx_calls: u32,
    rx_calls: u32,
}

#[derive(Row, Serialize)]
struct ProcRow {
    pid: u32,
    proc_start: u64,
    start_ms: i64,
    name: String,
    cmdline: String,
    uid: u32,
    first_seen: i64,
    last_seen: i64,
    ended: Option<i64>,
    tx_total: u64,
    rx_total: u64,
    version: u64,
}

pub async fn run(cfg: Config, mut rx: UnboundedReceiver<Arc<Tick>>) {
    // The schema is applied without a default database, since it creates it.
    let admin = Client::default()
        .with_url(&cfg.url)
        .with_user(&cfg.user)
        .with_password(&cfg.password);
    let client = admin
        .clone()
        .with_database("netwatch")
        .with_compression(clickhouse::Compression::Lz4);
    let mut schema_ok = false;
    let mut flows: Vec<FlowRow> = Vec::new();
    let mut procs: Vec<ProcRow> = Vec::new();
    let mut last_flush = Instant::now();

    loop {
        let tick = rx.recv().await;
        let closing = tick.is_none();
        if let Some(t) = tick {
            append(&t, &mut flows, &mut procs);
        }
        if !closing && last_flush.elapsed() < cfg.flush_every {
            continue;
        }
        last_flush = Instant::now();

        if !schema_ok {
            match apply_schema(&admin).await {
                Ok(()) => {
                    log::info!("clickhouse: connected to {}, schema ready", cfg.url);
                    schema_ok = true;
                }
                Err(e) => log::warn!("clickhouse: schema setup failed: {e}"),
            }
        }
        if schema_ok {
            if let Err(e) = flush(&client, &mut flows, &mut procs).await {
                log::warn!("clickhouse: insert failed ({} rows buffered): {e}", flows.len());
                schema_ok = false;
            }
        }
        trim(&mut flows, cfg.max_buffered_rows);
        trim(&mut procs, cfg.max_buffered_rows);
        if closing {
            return;
        }
    }
}

fn append(t: &Tick, flows: &mut Vec<FlowRow>, procs: &mut Vec<ProcRow>) {
    flows.extend(t.flows.iter().map(|f| FlowRow {
        ts: t.ts_ms,
        interval_ms: t.interval_ms,
        pid: f.pid,
        proc_start: f.start_ns,
        name: f.name.to_string(),
        uid: f.uid,
        proto: f.proto,
        app: f.app,
        raddr: f.raddr,
        rport: f.rport,
        lport: f.lport,
        tx_bytes: f.tx_bytes,
        rx_bytes: f.rx_bytes,
        tx_calls: f.tx_calls,
        rx_calls: f.rx_calls,
    }));
    procs.extend(t.procs.iter().filter(|p| p.changed).map(|p| ProcRow {
        pid: p.pid,
        proc_start: p.start_ns,
        start_ms: p.start_ms,
        name: p.name.to_string(),
        cmdline: p.cmdline.to_string(),
        uid: p.uid,
        first_seen: p.first_seen_ms,
        last_seen: p.last_seen_ms,
        ended: p.ended_ms,
        tx_total: p.tx_total,
        rx_total: p.rx_total,
        version: t.ts_ms as u64,
    }));
}

async fn flush(
    client: &Client,
    flows: &mut Vec<FlowRow>,
    procs: &mut Vec<ProcRow>,
) -> clickhouse::error::Result<()> {
    if !flows.is_empty() {
        let mut ins = client.insert::<FlowRow>("flows")?;
        for r in flows.iter() {
            ins.write(r).await?;
        }
        ins.end().await?;
        flows.clear();
    }
    if !procs.is_empty() {
        let mut ins = client.insert::<ProcRow>("processes")?;
        for r in procs.iter() {
            ins.write(r).await?;
        }
        ins.end().await?;
        procs.clear();
    }
    Ok(())
}

async fn apply_schema(client: &Client) -> clickhouse::error::Result<()> {
    let sql: String = SCHEMA
        .lines()
        .filter(|l| !l.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    for stmt in sql.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        client.query(stmt).execute().await?;
    }
    Ok(())
}

fn trim<T>(buf: &mut Vec<T>, max: usize) {
    if buf.len() > max {
        let excess = buf.len() - max;
        log::warn!("clickhouse: buffer full, discarding {excess} oldest rows");
        buf.drain(..excess);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs the compose stack: `docker compose up -d && cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn round_trip() {
        let admin = Client::default()
            .with_url("http://127.0.0.1:8123")
            .with_user("netwatch")
            .with_password("netwatch");
        apply_schema(&admin).await.unwrap();
        let client = admin.clone().with_database("netwatch");
        let t = crate::model::sample_tick();
        let (mut flows, mut procs) = (Vec::new(), Vec::new());
        append(&t, &mut flows, &mut procs);
        flush(&client, &mut flows, &mut procs).await.unwrap();

        let (name, addr, rx): (String, String, u64) = client
            .query("SELECT name, IPv6NumToString(raddr), rx_bytes FROM flows WHERE pid = 4242 AND ts = fromUnixTimestamp64Milli(?)")
            .bind(t.ts_ms)
            .fetch_one()
            .await
            .unwrap();
        assert_eq!((name.as_str(), addr.as_str(), rx), ("curl", "::ffff:93.184.216.34", 64000));
        client.query("DELETE FROM flows WHERE pid = 4242").execute().await.unwrap();
        client.query("DELETE FROM processes WHERE pid = 4242").execute().await.unwrap();
    }
}
