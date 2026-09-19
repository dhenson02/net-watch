# net-watch

Per-process network accounting for Linux, built on eBPF with [Aya](https://aya-rs.dev).
For every process, running or ended, it records:

- the process name, PID, command line and UID
- send and receive rates (kbps) for each interval
- total bytes sent and received
- the remote IP address and port of each destination
- the transport (TCP/UDP) and application protocol (HTTPS, HTTP, SSH, FTP, DNS,
  QUIC, PostgreSQL, …)

Data goes to **Redis** for realtime readers and to **ClickHouse**
for history and analytics. `web/` holds a separate dashboard app that reads
both (see `web/README.md`).

## How it keeps overhead low

```
 kernel                                       │ userspace (pinned to 2 cores)
                                              │
 tcp_sendmsg ─ fexit ─┐                       │  every interval (default 1 s):
 tcp_cleanup_rbuf ─ fentry ─┤  per-flow       │   1. flip ACTIVE (A⇄B)
 udp[v6]_sendmsg ─ fexit ─┼─► counters in ─►  │   2. batch lookup-and-delete the idle map
 udp[v6]_recvmsg ─ fexit ─┘  FLOWS_A / B      │   3. aggregate, classify, compute rates
                              (atomic add)    │   4. Redis: 1 MULTI pipeline
 sched_process_exit ─ tp_btf ─► ring buffer ─►│   5. ClickHouse: 1 RowBinary+LZ4 batch
```

- **fentry/fexit trampolines** are the cheapest way to attach to kernel functions.
  They cost less than kprobes, and much less than per-packet hooks such as
  TC/XDP or libpcap.
- **Hooks are at the socket layer, not the packet layer.** Each send or receive
  *call* costs one hash lookup and two atomic adds, however many packets it
  carries. For example, a 1 MB `send()` is counted once.
- **Counters are aggregated in the kernel.** Per-event data is never copied to
  userspace. Kernel→user traffic grows with the number of active flows, not with
  the number of bytes.
- **Two flow maps are double-buffered.** Userspace switches the programs to the
  other map, then drains the idle one with `BPF_MAP_LOOKUP_AND_DELETE_BATCH`.
  This reads and resets thousands of flows in one or two syscalls, and it never
  blocks writers.
- **Struct offsets are resolved at runtime from `/sys/kernel/btf/vmlinux`.**
  They are injected as read-only globals. A single 80-byte read of `struct sock` returns every field the key needs.
- **Process names and exits:** the group leader's `comm` and start time are read
  only once per flow per interval. Exit events are sent only for processes that
  used the network.
- **CPU isolation:**
  - The collector pins itself to `--cpus` (default: the last 2 logical CPUs,
    `62,63` here). Every thread it creates inherits that mask. It runs a single
    tokio thread.
  - Redis and ClickHouse are pinned to `NETWATCH_DB_CPUS` (default `56-61`).
    ClickHouse has its self-monitoring logs turned off, so it stays quiet at one
    insert per second.
  - The eBPF programs necessarily run inline on whichever CPU makes the syscall.
    That cost is one hash lookup and a few helper calls per `send`/`recv` call.
- **No hot-path allocation:** hash maps are preallocated (1M entries each, about
  150 MB, which fits easily in 256 GB).

For stronger isolation, add `isolcpus=56-63 nohz_full=56-63 rcu_nocbs=56-63` to
the kernel command line. The scheduler will then keep all other work off those
cores.

## Requirements

- Linux ≥ 5.17 with `CONFIG_DEBUG_INFO_BTF=y`. This machine runs 6.8, so both
  hold.
- Root (or `CAP_BPF` + `CAP_PERFMON`) to run the collector.
- Build: `rustup` with nightly and `rust-src` (the project pins this in
  `rust-toolchain.toml`), and `bpf-linker` (release binary:
  https://github.com/aya-rs/bpf-linker/releases).
- Docker Compose for the storage stack.

## Run

```sh
cp .env.example .env            # CPU sets, Redis memory, ClickHouse credentials
docker compose up -d --wait     # Redis :6379 + ClickHouse :8123, loopback only
cargo build --release
sudo ./target/release/net-watch --print     # --print: one summary line per tick
```

Useful flags (each also has a `NETWATCH_*` environment variable; see `--help`):

| flag | default | |
|---|---|---|
| `--interval-ms` | 1000 | aggregation and publish period |
| `--cpus` | last 2 CPUs | e.g. `62,63`, `60-63`, `all` |
| `--no-redis` / `--no-clickhouse` | | disable a sink |
| `--stream-maxlen` | 3600 | ticks kept in `netwatch:stream` |
| `--ended-ttl-secs` | 604800 | how long ended processes stay in Redis |
| `--no-sniff` | | disable TCP payload protocol sniffing |

To run it as a service: `deploy/net-watch.service` (instructions are inside the
file).

## Reading the data

### Realtime (Redis)

Each tick is written in one `MULTI/EXEC`, so readers never see a half-updated
state.

| key | type | content |
|---|---|---|
| `netwatch:snapshot` | string | JSON for the latest tick: `{ts_ms, interval_ms, drops, processes:[…], flows:[…]}`. `processes` lists every live process plus those that ended in the last 60 s, with current rates and totals. `flows` lists every flow active in this tick. |
| `netwatch:stream` | stream | the same JSON under field `json`, one entry per tick. Use for push-style consumers. |
| `netwatch:proc:{pid}:{start_ns}` | hash | `name cmdline uid pid start_ms first_seen_ms last_seen_ms alive ended_ms tx_kbps rx_kbps tx_total rx_total` |
| `netwatch:proc:{pid}:{start_ns}:dests` | hash | field `PROTO\|APP\|IP\|PORT` → `{"tx_total":…,"rx_total":…}` |
| `netwatch:alive` | set | ids (`pid:start_ns`) of live processes |
| `netwatch:ended` | zset | ids of ended processes, scored by end time (ms). Expire after `--ended-ttl-secs`. |
| `netwatch:meta` | hash | `last_tick_ms interval_ms drops` |

`(pid, start_ns)` identifies a process instance, so a reused PID never merges
two processes.

Getting everything is a single round trip:

```sh
redis-cli GET netwatch:snapshot | jq '.processes | sort_by(-.rx_kbps) | .[:10]'
```

To be woken on every tick instead of polling:

```sh
redis-cli XREAD BLOCK 0 STREAMS netwatch:stream '$'
```

In application code, loop on `XREAD BLOCK 0 STREAMS netwatch:stream <last-id>`.

### History (ClickHouse, `netwatch` database)

- `flows`: one row per process/destination/interval. Kept for 90 days.
  - Ordered by `(pid, proc_start, ts)`, with a `minmax` index on `ts` and a
    bloom filter on `raddr`.
- `flows_1m`: a per-minute rollup, filled by a materialized view. Kept for
  2 years.
- `processes`: the latest state of every process instance. Query it with
  `FINAL`.

```sql
-- top talkers in the last 5 minutes
SELECT name, pid, formatReadableSize(sum(tx_bytes)) tx, formatReadableSize(sum(rx_bytes)) rx
FROM netwatch.flows WHERE ts > now() - INTERVAL 5 MINUTE
GROUP BY name, pid ORDER BY sum(tx_bytes + rx_bytes) DESC LIMIT 20;

-- where did a process send data, and over what
SELECT app, IPv6NumToString(raddr) addr, rport, sum(tx_bytes) tx, sum(rx_bytes) rx
FROM netwatch.flows_1m WHERE name = 'firefox' AND minute > now() - INTERVAL 1 DAY
GROUP BY app, addr, rport ORDER BY tx DESC;

-- processes that have ended, with lifetime totals
SELECT pid, name, cmdline, ended, tx_total, rx_total
FROM netwatch.processes FINAL WHERE ended IS NOT NULL ORDER BY ended DESC LIMIT 50;
```

IPv4 addresses are stored IPv4-mapped (`::ffff:1.2.3.4`). `IPv6NumToString`
prints them in that form. In Redis and in the JSON they appear as plain IPv4.

## What is measured, and its limits

- **Bytes are application payload:** what processes hand to, or read from,
  TCP/UDP sockets. IP/TCP headers, retransmits and ACKs are not included. This is
  what a per-process "how much did it send" view normally reports.
- **Covered paths:**
  - TCP send: `send`, `write`, `sendmsg`, `sendfile`, `splice`, io_uring.
  - TCP receive: `recv`, `read`, `splice`, io_uring.
  - UDP send and receive over IPv4 and IPv6, including QUIC.
  - Containers: traffic is attributed to host PIDs.
- **Not covered:** raw sockets, ICMP ping sockets, SCTP, AF_PACKET, and traffic
  forwarded or routed by the kernel itself (NAT, bridges). None of these belong
  to a local process's socket calls.
- **UDP remote address:** on unconnected UDP sockets it comes from
  `msg_name`. If a receiver passes no address buffer, the remote shows as
  `0.0.0.0:0`.
- **Protocol labels:**
  1. The first 8 bytes of TCP payload are sniffed once per flow per interval.
     This detects TLS, HTTP/1.x, HTTP/2 prior-knowledge and SSH on any port.
     The result is cached per flow.
  2. Otherwise the well-known port is used (remote port first, then local
     port).
  3. Anything else is labelled `unknown`.
  - HTTPS is TLS on 443/8443 or TLS on an HTTP port. UDP/443 is QUIC.
- **Interval boundaries:** after switching maps the collector waits 2 ms before
  draining. A program still mid-update on the old map after that window lands its
  bytes in the next drain of that map. They are late, not lost.
- **Map capacity:** if more than 1M distinct flows appear in one interval, the
  extra inserts are counted in `drops`. This is logged and published in
  `netwatch:meta`.

## Layout

```
net-watch-ebpf/     kernel programs (no_std, bpfel-unknown-none)
net-watch-common/   #[repr(C)] types shared by kernel and userspace
net-watch/          collector: BTF offsets, loader/drain, aggregation, sinks
clickhouse/         schema + server config
deploy/             systemd unit
web/                dashboard (standalone Node + React app, reads Redis/ClickHouse)
```

Tests: `cargo test`. The `--ignored` integration tests need the compose stack
running.
