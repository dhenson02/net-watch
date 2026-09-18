//! Turns drained kernel counters into per-process / per-destination state.

use std::{
    collections::{hash_map::Entry, HashMap},
    net::{IpAddr, Ipv6Addr},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use net_watch_common::{ExitEvent, FlowKey, FlowStats};

use crate::classify::{self, Sniffed};

/// How long ended processes stay in memory (and in the snapshot) after exit.
const ENDED_RETAIN_MS: i64 = 60_000;
const LIVENESS_EVERY_MS: i64 = 5_000;
const APP_CACHE_TTL_MS: i64 = 10 * 60_000;

type ProcId = (u32, u64);

/// One row per (process, remote endpoint, local port) per interval.
#[derive(Serialize, Clone)]
pub struct FlowRec {
    pub pid: u32,
    pub start_ns: u64,
    pub name: Arc<str>,
    pub uid: u32,
    pub proto: &'static str,
    pub app: &'static str,
    #[serde(serialize_with = "ser_ip")]
    pub raddr: Ipv6Addr,
    pub rport: u16,
    pub lport: u16,
    pub tx_bytes: u64,
    pub rx_bytes: u64,
    pub tx_calls: u32,
    pub rx_calls: u32,
    pub tx_kbps: f64,
    pub rx_kbps: f64,
}

#[derive(Serialize, Clone)]
pub struct ProcView {
    pub pid: u32,
    pub start_ns: u64,
    pub start_ms: i64,
    pub name: Arc<str>,
    pub cmdline: Arc<str>,
    pub uid: u32,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub ended_ms: Option<i64>,
    pub tx_kbps: f64,
    pub rx_kbps: f64,
    pub tx_total: u64,
    pub rx_total: u64,
    /// State differs from what was last published (for sinks that only write deltas).
    #[serde(skip)]
    pub changed: bool,
}

/// Cumulative totals per (process, destination), emitted when they change.
#[derive(Serialize, Clone)]
pub struct DestView {
    pub pid: u32,
    pub start_ns: u64,
    pub proto: &'static str,
    pub app: &'static str,
    #[serde(serialize_with = "ser_ip")]
    pub raddr: Ipv6Addr,
    pub rport: u16,
    pub tx_total: u64,
    pub rx_total: u64,
}

pub struct Tick {
    pub ts_ms: i64,
    pub interval_ms: u32,
    pub drops: u64,
    pub flows: Vec<FlowRec>,
    /// All live processes plus those that ended within `ENDED_RETAIN_MS`.
    pub procs: Vec<ProcView>,
    pub dests: Vec<DestView>,
}

fn ser_ip<S: serde::Serializer>(ip: &Ipv6Addr, s: S) -> Result<S::Ok, S::Error> {
    s.collect_str(&display_ip(ip))
}

/// IPv4-mapped addresses are shown as plain IPv4.
pub fn display_ip(ip: &Ipv6Addr) -> IpAddr {
    ip.to_canonical()
}

#[derive(Hash, PartialEq, Eq, PartialOrd, Ord, Clone, Copy)]
struct DestKey {
    proto: u8,
    app: &'static str,
    raddr: [u8; 16],
    rport: u16,
}

struct Proc {
    view: ProcView,
    tick_tx: u64,
    tick_rx: u64,
    dests: HashMap<DestKey, (u64, u64)>,
}

pub struct Aggregator {
    procs: HashMap<ProcId, Proc>,
    /// Sticky payload-sniffing results, since only the first send of each
    /// interval is sniffed and later sends (e.g. mid-stream) may not match.
    app_cache: HashMap<(FlowKey, u64), (Sniffed, i64)>,
    clock: Clock,
    clk_tck: u64,
    last_liveness_ms: i64,
    last_prune_ms: i64,
    /// Exits whose process has not been seen yet: its final counters may still
    /// sit in the map that is drained next tick. Retried once.
    pending_exits: Vec<ExitEvent>,
}

impl Aggregator {
    pub fn new() -> Self {
        Self {
            procs: HashMap::new(),
            app_cache: HashMap::new(),
            clock: Clock::now(),
            clk_tck: unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64,
            last_liveness_ms: 0,
            last_prune_ms: 0,
            pending_exits: Vec::new(),
        }
    }

    pub fn ingest(
        &mut self,
        flows: &[(FlowKey, FlowStats)],
        exits: &[ExitEvent],
        elapsed: Duration,
        drops: u64,
    ) -> Tick {
        self.clock = Clock::now();
        let now = self.clock.wall_ms;
        let secs = elapsed.as_secs_f64().max(1e-3);
        let kbps = |bytes: u64| bytes as f64 * 8.0 / 1000.0 / secs;

        for p in self.procs.values_mut() {
            p.tick_tx = 0;
            p.tick_rx = 0;
            // Only a process that had a non-zero rate needs republishing when it goes idle.
            p.view.changed = p.view.tx_kbps != 0.0 || p.view.rx_kbps != 0.0;
        }

        let mut dest_changed: Vec<(ProcId, DestKey)> = Vec::new();
        let mut recs = Vec::with_capacity(flows.len());
        for (k, s) in flows {
            let id = (k.tgid, s.start_ns);
            let proc = match self.procs.entry(id) {
                Entry::Occupied(e) => e.into_mut(),
                Entry::Vacant(e) => e.insert(new_proc(k, s, now, &self.clock, self.clk_tck)),
            };
            let name = comm_str(&s.comm);
            if *proc.view.name != *name && !name.is_empty() {
                // The process exec()'d into something else.
                proc.view.name = name.into();
            }
            proc.view.last_seen_ms = now;
            proc.view.tx_total += s.tx_bytes;
            proc.view.rx_total += s.rx_bytes;
            proc.view.changed = true;
            proc.tick_tx += s.tx_bytes;
            proc.tick_rx += s.rx_bytes;

            let head = &s.head[..(s.head_len as usize).min(s.head.len())];
            let cache_key = (*k, s.start_ns);
            let sniffed = match classify::sniff(head) {
                Some(found) => {
                    self.app_cache.insert(cache_key, (found, now));
                    Some(found)
                }
                None => self.app_cache.get_mut(&cache_key).map(|(v, seen)| {
                    *seen = now;
                    *v
                }),
            };
            let app = classify::app(k.proto, k.rport, k.lport, sniffed);

            let dk = DestKey { proto: k.proto, app, raddr: k.raddr, rport: k.rport };
            let d = proc.dests.entry(dk).or_default();
            d.0 += s.tx_bytes;
            d.1 += s.rx_bytes;
            dest_changed.push((id, dk));

            recs.push(FlowRec {
                pid: k.tgid,
                start_ns: s.start_ns,
                name: proc.view.name.clone(),
                uid: s.uid,
                proto: classify::transport(k.proto),
                app,
                raddr: Ipv6Addr::from(k.raddr),
                rport: k.rport,
                lport: k.lport,
                tx_bytes: s.tx_bytes,
                rx_bytes: s.rx_bytes,
                tx_calls: s.tx_calls.min(u32::MAX as u64) as u32,
                rx_calls: s.rx_calls.min(u32::MAX as u64) as u32,
                tx_kbps: kbps(s.tx_bytes),
                rx_kbps: kbps(s.rx_bytes),
            });
        }

        let retry = std::mem::take(&mut self.pending_exits);
        for (i, e) in retry.iter().chain(exits).enumerate() {
            match self.procs.get_mut(&(e.tgid, e.start_ns)) {
                Some(p) if p.view.ended_ms.is_none() => {
                    p.view.ended_ms = Some(self.clock.boot_to_wall_ms(e.ts_ns));
                    p.view.changed = true;
                }
                Some(_) => {}
                None if i >= retry.len() => self.pending_exits.push(*e),
                None => {}
            }
        }
        if now - self.last_liveness_ms >= LIVENESS_EVERY_MS {
            self.last_liveness_ms = now;
            self.sweep_dead(now);
        }

        for p in self.procs.values_mut() {
            p.view.tx_kbps = kbps(p.tick_tx);
            p.view.rx_kbps = kbps(p.tick_rx);
        }

        dest_changed.sort_unstable();
        dest_changed.dedup();
        let dests = dest_changed
            .into_iter()
            .filter_map(|(id, dk)| {
                let (tx, rx) = *self.procs.get(&id)?.dests.get(&dk)?;
                Some(DestView {
                    pid: id.0,
                    start_ns: id.1,
                    proto: classify::transport(dk.proto),
                    app: dk.app,
                    raddr: Ipv6Addr::from(dk.raddr),
                    rport: dk.rport,
                    tx_total: tx,
                    rx_total: rx,
                })
            })
            .collect();

        let procs = self.procs.values().map(|p| p.view.clone()).collect();

        // Forget processes that ended a while ago; they live on in the sinks.
        if now - self.last_prune_ms >= ENDED_RETAIN_MS {
            self.last_prune_ms = now;
            self.procs
                .retain(|_, p| p.view.ended_ms.is_none_or(|t| now - t < ENDED_RETAIN_MS));
            let procs = &self.procs;
            self.app_cache.retain(|(k, start), (_, seen)| {
                now - *seen < APP_CACHE_TTL_MS && procs.contains_key(&(k.tgid, *start))
            });
        }

        Tick {
            ts_ms: now,
            interval_ms: elapsed.as_millis() as u32,
            drops,
            flows: recs,
            procs,
            dests,
        }
    }

    /// Catches exits the ring buffer missed (LRU eviction, collector restarts)
    /// by checking that each live process still exists with the same start time.
    fn sweep_dead(&mut self, now: i64) {
        let ns_per_tick = 1_000_000_000 / self.clk_tck;
        for ((pid, start_ns), p) in self.procs.iter_mut() {
            if p.view.ended_ms.is_some() || now - p.view.last_seen_ms < LIVENESS_EVERY_MS {
                continue;
            }
            if proc_starttime_ticks(*pid) != Some(start_ns / ns_per_tick) {
                p.view.ended_ms = Some(now);
                p.view.changed = true;
            }
        }
    }
}

fn new_proc(k: &FlowKey, s: &FlowStats, now: i64, clock: &Clock, clk_tck: u64) -> Proc {
    // Only trust /proc if it is still the same process instance.
    let alive = proc_starttime_ticks(k.tgid) == Some(s.start_ns / (1_000_000_000 / clk_tck));
    let cmdline = if alive { read_cmdline(k.tgid) } else { String::new() };
    Proc {
        view: ProcView {
            pid: k.tgid,
            start_ns: s.start_ns,
            start_ms: clock.boot_to_wall_ms(s.start_ns),
            name: comm_str(&s.comm).into(),
            cmdline: cmdline.into(),
            uid: s.uid,
            first_seen_ms: now,
            last_seen_ms: now,
            ended_ms: None,
            tx_kbps: 0.0,
            rx_kbps: 0.0,
            tx_total: 0,
            rx_total: 0,
            changed: true,
        },
        tick_tx: 0,
        tick_rx: 0,
        dests: HashMap::new(),
    }
}

fn comm_str(comm: &[u8]) -> String {
    let n = comm.iter().position(|&b| b == 0).unwrap_or(comm.len());
    String::from_utf8_lossy(&comm[..n]).into_owned()
}

fn read_cmdline(pid: u32) -> String {
    let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
        return String::new();
    };
    let mut s: String = String::from_utf8_lossy(&raw).replace('\0', " ").trim_end().to_owned();
    s.truncate(4096);
    s
}

/// Field 22 of /proc/<pid>/stat: start time in clock ticks since boot.
fn proc_starttime_ticks(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm (field 2) may contain spaces/parens; fields after the last ')' start at 3.
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_ascii_whitespace().nth(19)?.parse().ok()
}

/// Correlates kernel boot-time timestamps with wall-clock time.
#[derive(Clone, Copy)]
pub struct Clock {
    pub wall_ms: i64,
    boot_ns: u64,
}

impl Clock {
    pub fn now() -> Self {
        let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut ts) };
        let wall = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        Self {
            wall_ms: wall.as_millis() as i64,
            boot_ns: ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64,
        }
    }

    pub fn boot_to_wall_ms(&self, boot_ns: u64) -> i64 {
        self.wall_ms - (self.boot_ns as i64 - boot_ns as i64) / 1_000_000
    }
}

#[cfg(test)]
pub(crate) fn sample_tick() -> Tick {
    let now = Clock::now().wall_ms;
    let name: Arc<str> = "curl".into();
    let raddr = Ipv6Addr::from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 93, 184, 216, 34]);
    Tick {
        ts_ms: now,
        interval_ms: 1000,
        drops: 0,
        flows: vec![FlowRec {
            pid: 4242,
            start_ns: 1,
            name: name.clone(),
            uid: 1000,
            proto: "TCP",
            app: "HTTPS",
            raddr,
            rport: 443,
            lport: 50000,
            tx_bytes: 1500,
            rx_bytes: 64000,
            tx_calls: 3,
            rx_calls: 40,
            tx_kbps: 12.0,
            rx_kbps: 512.0,
        }],
        procs: vec![ProcView {
            pid: 4242,
            start_ns: 1,
            start_ms: now - 5000,
            name,
            cmdline: "curl https://example.com".into(),
            uid: 1000,
            first_seen_ms: now,
            last_seen_ms: now,
            ended_ms: None,
            tx_kbps: 12.0,
            rx_kbps: 512.0,
            tx_total: 1500,
            rx_total: 64000,
            changed: true,
        }],
        dests: vec![DestView {
            pid: 4242,
            start_ns: 1,
            proto: "TCP",
            app: "HTTPS",
            raddr,
            rport: 443,
            tx_total: 1500,
            rx_total: 64000,
        }],
    }
}
