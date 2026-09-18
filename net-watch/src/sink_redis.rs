//! Realtime state in Redis: a single-key snapshot, a stream for push-style
//! consumers, and per-process hashes for random access. Every write is an
//! absolute value (never an increment), so a reconnect or a skipped tick can
//! never make the data drift.

use std::sync::Arc;

use redis::aio::ConnectionManager;
use serde::Serialize;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::model::{display_ip, FlowRec, ProcView, Tick};

pub const KEY_SNAPSHOT: &str = "netwatch:snapshot";
pub const KEY_STREAM: &str = "netwatch:stream";
pub const KEY_META: &str = "netwatch:meta";
pub const KEY_ALIVE: &str = "netwatch:alive";
pub const KEY_ENDED: &str = "netwatch:ended";

pub struct Config {
    pub url: String,
    pub stream_maxlen: usize,
    pub ended_ttl_secs: u64,
}

#[derive(Serialize)]
struct Snapshot<'a> {
    ts_ms: i64,
    interval_ms: u32,
    drops: u64,
    processes: &'a [ProcView],
    flows: &'a [FlowRec],
}

pub async fn run(cfg: Config, mut rx: UnboundedReceiver<Arc<Tick>>) {
    let client = match redis::Client::open(cfg.url.as_str()) {
        Ok(c) => c,
        Err(e) => return log::error!("redis: invalid url {}: {e}", cfg.url),
    };
    let mut con: Option<ConnectionManager> = None;
    // Everything is (re)written after connecting, not only what changed.
    let mut full_sync = true;
    let mut last_prune = 0i64;

    while let Some(tick) = rx.recv().await {
        if con.is_none() {
            match ConnectionManager::new(client.clone()).await {
                Ok(c) => {
                    log::info!("redis: connected to {}", cfg.url);
                    con = Some(c);
                    full_sync = true;
                }
                Err(e) => {
                    log::warn!("redis: connect failed: {e}");
                    continue;
                }
            }
        }
        let c = con.as_mut().unwrap();
        let prune = tick.ts_ms - last_prune >= 60_000;
        let pipe = build(&cfg, &tick, full_sync, prune);
        match pipe.query_async::<()>(c).await {
            Ok(()) => {
                full_sync = false;
                if prune {
                    last_prune = tick.ts_ms;
                }
            }
            Err(e) => {
                log::warn!("redis: write failed: {e}");
                full_sync = true;
                if e.is_connection_dropped() || e.is_io_error() {
                    con = None;
                }
            }
        }
    }
}

fn build(cfg: &Config, t: &Tick, full: bool, prune: bool) -> redis::Pipeline {
    let mut p = redis::pipe();
    // MULTI/EXEC: readers never observe a half-written tick.
    p.atomic();
    let snap = serde_json::to_string(&Snapshot {
        ts_ms: t.ts_ms,
        interval_ms: t.interval_ms,
        drops: t.drops,
        processes: &t.procs,
        flows: &t.flows,
    })
    .unwrap_or_default();

    p.set(KEY_SNAPSHOT, &snap).ignore();
    p.cmd("XADD")
        .arg(KEY_STREAM)
        .arg("MAXLEN")
        .arg("~")
        .arg(cfg.stream_maxlen)
        .arg("*")
        .arg("json")
        .arg(&snap)
        .ignore();
    p.hset_multiple(
        KEY_META,
        &[
            ("last_tick_ms", t.ts_ms.to_string()),
            ("interval_ms", t.interval_ms.to_string()),
            ("drops", t.drops.to_string()),
        ],
    )
    .ignore();

    let ttl = cfg.ended_ttl_secs as i64;
    if full {
        // Rebuilt below from current state; drops leftovers of a previous run.
        p.del(KEY_ALIVE).ignore();
    }
    for v in t.procs.iter().filter(|v| full || v.changed) {
        let id = format!("{}:{}", v.pid, v.start_ns);
        let key = format!("netwatch:proc:{id}");
        p.hset_multiple(
            &key,
            &[
                ("pid", v.pid.to_string()),
                ("start_ns", v.start_ns.to_string()),
                ("start_ms", v.start_ms.to_string()),
                ("name", v.name.to_string()),
                ("cmdline", v.cmdline.to_string()),
                ("uid", v.uid.to_string()),
                ("first_seen_ms", v.first_seen_ms.to_string()),
                ("last_seen_ms", v.last_seen_ms.to_string()),
                ("ended_ms", v.ended_ms.unwrap_or(0).to_string()),
                ("alive", (v.ended_ms.is_none() as u8).to_string()),
                ("tx_kbps", format!("{:.3}", v.tx_kbps)),
                ("rx_kbps", format!("{:.3}", v.rx_kbps)),
                ("tx_total", v.tx_total.to_string()),
                ("rx_total", v.rx_total.to_string()),
            ],
        )
        .ignore();
        match v.ended_ms {
            None => {
                p.sadd(KEY_ALIVE, &id).ignore();
            }
            Some(ended) => {
                p.srem(KEY_ALIVE, &id).ignore();
                p.zadd(KEY_ENDED, &id, ended).ignore();
                p.expire(&key, ttl).ignore();
                p.expire(format!("{key}:dests"), ttl).ignore();
            }
        }
    }

    for d in &t.dests {
        let field = format!("{}|{}|{}|{}", d.proto, d.app, display_ip(&d.raddr), d.rport);
        let val = format!(r#"{{"tx_total":{},"rx_total":{}}}"#, d.tx_total, d.rx_total);
        p.hset(format!("netwatch:proc:{}:{}:dests", d.pid, d.start_ns), field, val).ignore();
    }

    if prune {
        // The hashes themselves expire via EXPIRE; drop their index entries too.
        p.zrembyscore(KEY_ENDED, "-inf", t.ts_ms - ttl * 1000).ignore();
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use redis::AsyncCommands;

    /// Needs the compose stack: `docker compose up -d && cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn round_trip() {
        let cfg = Config { url: "redis://127.0.0.1:6379/".into(), stream_maxlen: 10, ended_ttl_secs: 60 };
        let client = redis::Client::open(cfg.url.as_str()).unwrap();
        let mut c = client.get_multiplexed_async_connection().await.unwrap();
        let t = crate::model::sample_tick();
        build(&cfg, &t, false, false).query_async::<()>(&mut c).await.unwrap();

        let snap: String = c.get(KEY_SNAPSHOT).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&snap).unwrap();
        assert_eq!(v["flows"][0]["raddr"], "93.184.216.34");
        assert_eq!(v["processes"][0]["name"], "curl");
        let total: String = c.hget("netwatch:proc:4242:1", "rx_total").await.unwrap();
        assert_eq!(total, "64000");
        let dest: String =
            c.hget("netwatch:proc:4242:1:dests", "TCP|HTTPS|93.184.216.34|443").await.unwrap();
        assert_eq!(dest, r#"{"tx_total":1500,"rx_total":64000}"#);
        let _: () = redis::pipe()
            .del(&["netwatch:proc:4242:1", "netwatch:proc:4242:1:dests", KEY_SNAPSHOT, KEY_STREAM, KEY_META])
            .srem(KEY_ALIVE, "4242:1")
            .query_async(&mut c)
            .await
            .unwrap();
    }
}
