# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

net-watch is a per-process network accounting daemon for Linux. It uses eBPF (Aya) and publishes to Redis (realtime) and ClickHouse (history). It has no UI. README.md documents the Redis key layout, the ClickHouse tables, the CLI flags and the measurement limits.

## Commands

```sh
cargo build --release                      # also builds the eBPF object (see Build below)
sudo ./target/release/net-watch --print    # needs root / CAP_BPF+CAP_PERFMON; --print logs one line per tick
sudo ./target/release/net-watch --print --no-redis --no-clickhouse   # run without the storage stack
cargo test                                 # unit tests
cargo test <name>                          # one test, e.g. `cargo test resolves_running_kernel`
docker compose up -d --wait                # Redis :6379 + ClickHouse :8123 (loopback, host network)
cargo test -- --ignored                    # integration round-trip tests; need the compose stack
cargo clippy / cargo fmt
```

`RUST_LOG=net_watch=debug` prints the resolved kernel offsets at startup. Plain `RUST_LOG=debug` also floods the log with output from dependencies.

## Build

- `rust-toolchain.toml` pins **nightly** with `rust-src`. The eBPF crate uses `core_intrinsics` (`atomic_xadd`, which lowers to `BPF_ATOMIC ADD`).
- `bpf-linker` must be on `PATH`. `net-watch-ebpf/build.rs` panics without it. `cargo install bpf-linker` fails on this machine because there is no system `llvm-config`. Use the prebuilt `x86_64-unknown-linux-musl` release binary from github.com/aya-rs/bpf-linker instead.
- The workspace `default-members` leave out `net-watch-ebpf`. Do not build that crate directly for the host. `net-watch/build.rs` compiles it for the BPF target through `aya-build`, and the object is embedded in the collector. `net-watch-ebpf` is listed as a build-dependency only so that cargo rebuilds when the eBPF sources change.

## Architecture

There are three crates. Most changes cross all of them:

- **`net-watch-common`**: `#[repr(C)]` structs shared by the kernel and userspace (`FlowKey`, `FlowStats`, `ExitEvent`, `Offsets`). Padding is explicit so both sides see the same layout and the verifier never sees uninitialised stack. The `user` feature adds the `aya::Pod` impls. When you change a struct here, update the eBPF code, `probe.rs` and `model.rs` together.
- **`net-watch-ebpf/src/main.rs`**: fentry/fexit hooks on `tcp_sendmsg`, `tcp_cleanup_rbuf`, `udp[v6]_{send,recv}msg`, plus a `sched_process_exit` BTF tracepoint. Counters are aggregated in the kernel, per flow, into one of two hash maps (`FLOWS_A`/`FLOWS_B`). `ACTIVE[0]` selects the map. Exits go through the `EXITS` ring buffer, but only for tgids in `PROCS`, which holds processes that did network I/O.
- **`net-watch/`** (userspace collector) runs one pipeline per tick:
  1. `btf.rs`: a minimal BTF parser for `/sys/kernel/btf/vmlinux`. Aya's Rust eBPF has **no CO-RE relocations**, so every kernel struct offset is resolved here at startup and written into the `OFFSETS` read-only global before load. To read a new kernel field in eBPF, add it to `Offsets`, resolve it in `resolve_offsets`, and read it through the offset. Never hard-code a layout. `sock_common` fields are fetched with a single `SK_BLOCK` (80-byte) read relative to `sk_base`. If the `iov_iter` lookups fail, sniffing is disabled rather than failing startup.
  2. `probe.rs`: loads and attaches the programs. `flip()` switches `ACTIVE`. `drain()` empties the idle map with a raw `BPF_MAP_LOOKUP_AND_DELETE_BATCH` syscall, which has its own `bpf_attr` struct because Aya does not expose it. It also reads the exit ring buffer and the per-CPU `DROPS` counter.
  3. `main.rs`: a single-threaded tokio runtime. CPU affinity is set **before** the runtime is built so that every thread inherits it. Each tick runs flip → sleep 2 ms (lets in-flight programs finish) → drain → `Aggregator::ingest` → send `Arc<Tick>` to each sink over an unbounded channel.
  4. `model.rs` (`Aggregator`): keys processes by `(tgid, start_ns)`, so a reused PID never merges two processes. It computes rates, keeps cumulative per-destination totals, reads `/proc` cmdline only when the start time still matches, retries exits whose process has not been seen yet, sweeps for missed exits every 5 s, and prunes processes that ended more than 60 s ago. `sample_tick()` is the fixture the sink tests use.
  5. `classify.rs`: labels the application protocol from sniffed payload bytes (TLS/HTTP/h2/SSH), cached per flow. Otherwise it uses the well-known port, remote port before local port.
  6. Sinks, each an independent task that survives outages:
     - `sink_redis.rs` writes one `MULTI/EXEC` pipeline per tick. It only ever writes absolute values, never increments, and does a full resync after every reconnect or error.
     - `sink_clickhouse.rs` buffers RowBinary+LZ4 batches in memory while ClickHouse is down, capped by `--clickhouse-max-buffer`. It applies `clickhouse/schema.sql`, embedded with `include_str!`, idempotently on connect.

## Invariants to preserve

- The eBPF hot path is one map lookup plus relaxed atomic adds. Keep per-call work minimal: do not add per-event ring-buffer output or allocation.
- The collector's own tgid (`Offsets::self_tgid`) is excluded so that its DB traffic is not counted.
- `udp_sendmsg` skips AF_INET6 sockets (`IoKind::UdpV4Only`) because `udpv6_sendmsg` forwards v4-mapped sends to it. Without the skip, those bytes would be counted twice.
- IPv4 addresses are stored IPv4-mapped in the kernel key and in ClickHouse, and shown as plain IPv4 in Redis/JSON (`model::display_ip`).
- `clickhouse/schema.sql` is used both by the collector at startup and by the container on first boot (`docker-entrypoint-initdb.d`), so it must stay idempotent (`IF NOT EXISTS`).
- `sink_clickhouse::apply_schema` drops whole-line `--` comments, then splits the file on `;`. A semicolon inside a string literal or `COMMENT '...'` therefore breaks startup with a syntax error. The container's init path does not have this problem, so only the collector (or `cargo test -- --ignored`) catches it.
- fexit programs read the traced function's return value as `ctx.arg(N)`, where N is the function's argument count (`tcp_sendmsg`/`udp*_sendmsg` → 3, `udp*_recvmsg` → 5). They do not use `ctx.ret()`. When you add or change a hook, check the kernel prototype, e.g. `bpftool btf dump file /sys/kernel/btf/vmlinux | grep -A6 "FUNC 'name'"`, then the `FUNC_PROTO` it references.
- Payload sniffing (`sniff_head`) handles `ITER_UBUF` only. It assumes the kernel leaves `iov_iter.ubuf` pointing at the start of the payload after the send, which holds on 6.8. After a kernel upgrade, re-check that assumption: a wrong pointer produces wrong protocol labels, not an error.
- The CPU pinning defaults (collector on the last 2 CPUs, DBs on `NETWATCH_DB_CPUS`) are set for a 64-CPU host. See `.env.example` and `deploy/net-watch.service` (`CPUAffinity`).
