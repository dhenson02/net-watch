mod btf;
mod classify;
mod model;
mod probe;
mod sink_clickhouse;
mod sink_redis;

use std::{sync::Arc, time::Duration};

use anyhow::{bail, Context as _, Result};
use clap::Parser;
use tokio::{
    signal::unix::{signal, SignalKind},
    sync::mpsc::{unbounded_channel, UnboundedSender},
    time::{interval, sleep, Instant, MissedTickBehavior},
};

use crate::{model::Tick, probe::Probe};

/// Per-process network accounting via eBPF (fentry/fexit on the socket layer).
#[derive(Parser, Debug)]
#[command(version)]
struct Args {
    /// Aggregation / publish interval in milliseconds.
    #[arg(long, env = "NETWATCH_INTERVAL_MS", default_value_t = 1000)]
    interval_ms: u64,

    /// CPUs the collector may run on, e.g. "62,63" or "60-63". "all" disables
    /// pinning. Defaults to the last two logical CPUs.
    #[arg(long, env = "NETWATCH_CPUS")]
    cpus: Option<String>,

    /// Nice value for the collector (-20..19).
    #[arg(long, env = "NETWATCH_NICE", default_value_t = 0)]
    nice: i32,

    #[arg(long, env = "NETWATCH_REDIS_URL", default_value = "redis://127.0.0.1:6379/")]
    redis_url: String,
    #[arg(long, env = "NETWATCH_NO_REDIS")]
    no_redis: bool,
    /// Approximate number of ticks kept in the `netwatch:stream` Redis stream.
    #[arg(long, env = "NETWATCH_STREAM_MAXLEN", default_value_t = 3600)]
    stream_maxlen: usize,
    /// How long ended processes remain in Redis.
    #[arg(long, env = "NETWATCH_ENDED_TTL_SECS", default_value_t = 7 * 24 * 3600)]
    ended_ttl_secs: u64,

    #[arg(long, env = "NETWATCH_CLICKHOUSE_URL", default_value = "http://127.0.0.1:8123")]
    clickhouse_url: String,
    #[arg(long, env = "NETWATCH_CLICKHOUSE_USER", default_value = "netwatch")]
    clickhouse_user: String,
    #[arg(long, env = "NETWATCH_CLICKHOUSE_PASSWORD", default_value = "netwatch")]
    clickhouse_password: String,
    #[arg(long, env = "NETWATCH_NO_CLICKHOUSE")]
    no_clickhouse: bool,
    /// ClickHouse batch interval in milliseconds.
    #[arg(long, env = "NETWATCH_CLICKHOUSE_FLUSH_MS", default_value_t = 1000)]
    clickhouse_flush_ms: u64,
    #[arg(long, env = "NETWATCH_CLICKHOUSE_MAX_BUFFER", default_value_t = 20_000_000)]
    clickhouse_max_buffer: usize,

    /// Disable sniffing the first bytes of TCP payloads for protocol detection.
    #[arg(long, env = "NETWATCH_NO_SNIFF")]
    no_sniff: bool,

    /// Print a one-line summary of the busiest processes every interval.
    #[arg(long)]
    print: bool,
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = Args::parse();

    // Pin before the runtime exists so every thread it creates inherits the mask.
    pin_cpus(args.cpus.as_deref())?;
    if args.nice != 0 && unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, args.nice) } != 0 {
        log::warn!("setpriority({}) failed: {}", args.nice, std::io::Error::last_os_error());
    }

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(run(args))
}

async fn run(args: Args) -> Result<()> {
    let btf = btf::Btf::from_sys_fs()?;
    let offsets = btf::resolve_offsets(&btf, !args.no_sniff)?;
    drop(btf);
    log::debug!("kernel offsets: {offsets:?}");

    let mut probe = Probe::load(&offsets)?;
    log::info!("eBPF programs attached; interval {} ms", args.interval_ms);

    let mut sinks: Vec<UnboundedSender<Arc<Tick>>> = Vec::new();
    let mut tasks = Vec::new();
    if !args.no_redis {
        let (tx, rx) = unbounded_channel();
        sinks.push(tx);
        let cfg = sink_redis::Config {
            url: args.redis_url.clone(),
            stream_maxlen: args.stream_maxlen,
            ended_ttl_secs: args.ended_ttl_secs,
        };
        tasks.push(tokio::spawn(sink_redis::run(cfg, rx)));
    }
    if !args.no_clickhouse {
        let (tx, rx) = unbounded_channel();
        sinks.push(tx);
        let cfg = sink_clickhouse::Config {
            url: args.clickhouse_url.clone(),
            user: args.clickhouse_user.clone(),
            password: args.clickhouse_password.clone(),
            flush_every: Duration::from_millis(args.clickhouse_flush_ms),
            max_buffered_rows: args.clickhouse_max_buffer,
        };
        tasks.push(tokio::spawn(sink_clickhouse::run(cfg, rx)));
    }

    let mut agg = model::Aggregator::new();
    let mut flows = Vec::new();
    let mut exits = Vec::new();
    let mut ticker = interval(Duration::from_millis(args.interval_ms.max(10)));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ticker.tick().await;
    let mut last_flip = Instant::now();
    let mut last_drops = 0;

    let mut sigint = signal(SignalKind::interrupt())?;
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut stopping = false;

    while !stopping {
        tokio::select! {
            _ = ticker.tick() => {}
            _ = sigint.recv() => stopping = true,
            _ = sigterm.recv() => stopping = true,
        }

        let idle = probe.flip()?;
        let now = Instant::now();
        let elapsed = now - last_flip;
        last_flip = now;
        // Let programs that read the old ACTIVE value finish their update.
        sleep(Duration::from_millis(2)).await;

        flows.clear();
        exits.clear();
        probe.drain(idle, &mut flows)?;
        probe.drain_exits(&mut exits);

        let drops = probe.drops();
        if drops != last_drops {
            log::warn!("flow map full: {} inserts dropped so far", drops);
            last_drops = drops;
        }

        let tick = Arc::new(agg.ingest(&flows, &exits, elapsed, drops));
        if args.print {
            print_summary(&tick);
        }
        for s in &sinks {
            let _ = s.send(tick.clone());
        }
    }

    log::info!("shutting down, flushing sinks");
    drop(sinks);
    for t in tasks {
        let _ = tokio::time::timeout(Duration::from_secs(10), t).await;
    }
    Ok(())
}

fn print_summary(t: &Tick) {
    let mut active: Vec<_> =
        t.procs.iter().filter(|p| p.tx_kbps > 0.0 || p.rx_kbps > 0.0).collect();
    active.sort_by(|a, b| (b.tx_kbps + b.rx_kbps).total_cmp(&(a.tx_kbps + a.rx_kbps)));
    let top: Vec<String> = active
        .iter()
        .take(5)
        .map(|p| format!("{}[{}] ↑{:.1} ↓{:.1} kbps", p.name, p.pid, p.tx_kbps, p.rx_kbps))
        .collect();
    println!(
        "{} flows={} procs={} active={} | {}",
        t.ts_ms,
        t.flows.len(),
        t.procs.len(),
        active.len(),
        top.join(", ")
    );
}

fn pin_cpus(spec: Option<&str>) -> Result<()> {
    let ncpu = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let cpus: Vec<usize> = match spec {
        Some("all") => return Ok(()),
        Some(s) => parse_cpu_list(s)?,
        None if ncpu >= 4 => vec![ncpu - 2, ncpu - 1],
        None => return Ok(()),
    };
    let mut set: libc::cpu_set_t = unsafe { std::mem::zeroed() };
    for &c in &cpus {
        unsafe { libc::CPU_SET(c, &mut set) };
    }
    if unsafe { libc::sched_setaffinity(0, size_of::<libc::cpu_set_t>(), &set) } != 0 {
        bail!("sched_setaffinity({cpus:?}): {}", std::io::Error::last_os_error());
    }
    log::info!("collector pinned to CPUs {cpus:?}");
    Ok(())
}

fn parse_cpu_list(s: &str) -> Result<Vec<usize>> {
    let mut out = Vec::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        match part.split_once('-') {
            Some((a, b)) => {
                let (a, b): (usize, usize) = (a.parse()?, b.parse()?);
                out.extend(a..=b);
            }
            None => out.push(part.parse().with_context(|| format!("bad CPU '{part}'"))?),
        }
    }
    if out.is_empty() {
        bail!("empty CPU list");
    }
    Ok(out)
}
