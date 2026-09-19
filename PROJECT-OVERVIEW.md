# net-watch: Per-Process Network Accounting Architecture Overview

**Context**: This document describes net-watch's architecture and design for reference when building a non-rooted Android alternative. It is **not** a direct port guide—the eBPF foundation of the Linux version does not apply on Android.

---

## Project Goals

**Core mission**: Record which **processes** (not packets) send and receive data, and to **where**.

For each process and its network destinations, track:
- **Rates**: kilobits per second transmitted/received in each measurement interval
- **Totals**: cumulative bytes sent/received over the process lifetime
- **Protocol labels**: TCP/UDP, then application-level protocols (HTTPS, SSH, HTTP, DNS, QUIC, FTP, etc.)
- **Endpoint information**: remote IP, remote port, local port, transport protocol
- **Process metadata**: PID, process name, command line, user ID, start time
- **Exit events**: know when a process terminates, even after it's gone

The output feeds two backends:
- **Redis** (realtime): for live dashboards, monitoring, alerts
- **ClickHouse** (timeseries): for historical analysis and trends

---

## Why This Architecture (Linux eBPF Design)

### The Problem
Traditional tools (pcap, netstat, /proc parsing) have trade-offs:
- **Packet sniffing** (tcpdump/libpcap): accurate but expensive CPU, needs special setup
- **/proc parsing**: works on any system but is slow, coarse-grained, can't see closed connections
- **iptables/tc rules**: system-wide hooks, not per-process

### The Solution: eBPF at Socket Syscall Layer
```
User space:  process calls send()/recv()
    ↓
Kernel:      syscall → tcp_sendmsg/tcp_cleanup_rbuf/udp_sendmsg/udp_recvmsg
    ↓
eBPF (fexit hooks):  read socket struct → extract IP/port/PID → atomic add to map
    ↓
Userspace collector:  every 1 s, read map → aggregate → publish
```

**Why fexit?**: Hooks run *after* the kernel function completes, so we can read return values and see what actually happened, not what was attempted.

**Why one per syscall, not per packet?** A single `send(1MB)` is one syscall; we count it once, not per TCP segment. This keeps the eBPF hot path minimal (one hash lookup + a few atomic adds) and the kernel→user data volume low (megabytes per second reported, not gigabytes).

---

## Architecture: Three Crates (Rust Workspace)

### 1. `net-watch-common/`: Shared Kernel-User Structs

**Purpose**: Define C-compatible data types that both the eBPF kernel programs and the userspace collector understand identically.

**Key types**:

```rust
struct FlowKey {  // Aggregation key: one entry per logical flow
    tgid: u32,           // Process group ID
    rport: u16,          // Remote port (host byte order)
    lport: u16,          // Local port
    raddr: [u8; 16],     // IPv6 (IPv4 stored as IPv4-mapped)
    family: u8,          // AF_INET or AF_INET6
    proto: u8,           // IPPROTO_TCP or IPPROTO_UDP
}

struct FlowStats {  // Per-flow counters accumulated in kernel, drained each interval
    tx_bytes: u64,       // Payload bytes sent
    rx_bytes: u64,       // Payload bytes received
    tx_calls: u32,       // Send syscalls
    rx_calls: u32,       // Receive syscalls
    start_ns: u64,       // Process start time (boot-relative)
    comm: [u8; 16],      // Process name (from task_struct)
    head: [u8; 8],       // First 8 bytes of TCP payload (for sniffing)
    uid: u32,            // User ID
}

struct ExitEvent {  // Sent via ring buffer when a process with network activity exits
    tgid: u32,
    start_ns: u64,
    ts_ns: u64,  // Exit timestamp
}

struct Offsets {  // Runtime-resolved kernel struct field offsets (from BTF)
    // All offsets relative to 'struct sock' or its embedded 'sock_common'
    sk_base: u32,        // Where to start reading the sock_common block
    skc_daddr: u32,      // Remote address field (within the block)
    skc_dport: u32,      // Remote port
    // ... more TCP/UDP specific offsets
    // These are resolved at startup from /sys/kernel/btf/vmlinux
    // and injected into eBPF programs as read-only globals
}
```

**Key invariant**: All structs are `#[repr(C)]` with **explicit padding**. This ensures kernel and userspace see the same byte layout; the eBPF verifier never sees uninitialized stack.

---

### 2. `net-watch-ebpf/`: Kernel Programs

**Written in**: Rust (via Aya) + embedded asm, compiled to BPF bytecode for the Linux kernel (5.17+).

**Does not apply to non-rooted Android** due to permission and kernel differences.

#### What It Does:

1. **Attach fentry/fexit hooks** to socket functions:
   - `tcp_sendmsg` (fexit): when TCP send completes
   - `tcp_cleanup_rbuf` (fentry): when TCP read buffer is freed (= data was read)
   - `udp_sendmsg`, `udpv6_sendmsg`, `udpv6_recvmsg` (fexit)
   - `sched_process_exit` (tp_btf tracepoint): when a process exits

2. **Per-hook logic** (simplified):
   ```
   1. Read 'struct sock' from memory (80 bytes from a resolved offset)
   2. Extract: socket family, addresses, ports, PID
   3. Build FlowKey from these fields
   4. Atomic add to FLOWS_A or FLOWS_B map
   ```

3. **Double-buffered maps**:
   - Two identical hash maps (FLOWS_A, FLOWS_B), each ~150 MB, 1M entries
   - Kernel threads add to the active map
   - Userspace flips a flag (`ACTIVE` global) → new syscalls go to the other map
   - Userspace drains the now-idle map
   - Next tick, flip again

4. **Exit events**: Only for processes that had network activity, sent to ring buffer.

---

### 3. `net-watch/`: Userspace Collector

**Language**: Rust with `tokio` (async single-threaded runtime)

**Pinned to CPU cores**: Runs on the last 2 CPUs (configurable) for isolation.

#### Main loop (each interval, default 1 second):

```
1. flip()        → Switch ACTIVE flag → kernel now writes to the other map
2. sleep 2ms     → Let in-flight syscalls finish
3. drain()       → Bulk-read the now-idle map, extract all drained flows
4. ingest()      → Parse flows, look up process metadata, compute rates
5. publish()     → Send to Redis and ClickHouse
```

#### Core modules:

**`btf.rs`: BTF Parser**
- Reads `/sys/kernel/btf/vmlinux` (kernel's type information)
- Resolves field offsets of `struct sock`, `task_struct`, etc. for the running kernel
- Writes `Offsets` struct into eBPF program's read-only data before load
- **Why**: Kernels differ (5.17 vs 6.2 vs 6.8), so struct layouts vary; hardcoding offsets breaks on upgrades
- **Not applicable to Android**: Android kernels are patchy, may not expose full BTF

**`probe.rs`: eBPF Loader**
- Uses Aya to load the eBPF bytecode, inject offsets, attach hooks
- Manages the two flow maps (FLOWS_A, FLOWS_B)
- `flip()`: sets ACTIVE to switch which map is active
- `drain()`: uses `BPF_MAP_LOOKUP_AND_DELETE_BATCH` syscall to read ~1000 entries in one call (efficient)
- Reads the exit ring buffer
- Reads the per-CPU `DROPS` counter (when a flow hash collides and can't insert)

**`model.rs`: Aggregator**
- Turns raw flow entries into process-level state
- Groups flows by `(pid, start_ns)` — reused PIDs never merge
- Reads `/proc/[pid]/cmdline` and `/proc/[pid]/stat` to get process name and user
- Tracks process lifecycle: first-seen, last-seen, ended
- Computes rates: `kbps = (bytes_this_interval / interval_ms) * 8`
- Caches process metadata (refreshes every 10 min or on state change)
- **Retries**: exit events for processes not yet seen (race condition handling)
- **Sweeping**: every 5 s, scans for missed exits; removes processes ended >60 s ago

**`classify.rs`: Protocol Detection**
- TCP payload sniffing: reads first 8 bytes of a TCP send → TLS handshake? HTTP? SSH?
- Falls back to well-known ports (remote port, then local port)
- Caches result per flow
- **HTTPS**: TLS on 443/8443, or TLS on HTTP port; UDP/443 is QUIC
- **DNS**: UDP/53; **FTP**: TCP/20-21; **PostgreSQL**: TCP/5432, etc.

**`main.rs`: Orchestration**
- Sets CPU affinity before spawning the tokio runtime
- Parses command-line flags and environment variables
- Manages the collector loop and sink tasks

#### Data Sinks:

**`sink_redis.rs`**:
- Published every tick in a single `MULTI/EXEC` transaction (atomic)
- Keys:
  - `netwatch:snapshot`: JSON of latest tick (ts, interval_ms, drops, processes, flows)
  - `netwatch:stream`: Redis stream, one entry per tick (for XREAD BLOCK consumers)
  - `netwatch:proc:{pid}:{start_ns}`: hash with per-process state (name, uid, cmdline, rates, totals)
  - `netwatch:proc:{pid}:{start_ns}:dests`: hash with per-destination summaries
  - `netwatch:alive`: set of `pid:start_ns` for live processes
  - `netwatch:ended`: sorted set of ended process IDs (scored by end time)
  - `netwatch:meta`: tick timestamp, interval, drop count
- **Design goal**: Readers see snapshot-consistent data; never partial updates
- **Durability**: Ephemeral; no persistence (you need Redis snapshots for that)

**`sink_clickhouse.rs`**:
- Uses RowBinary + LZ4 compression for efficient bulk inserts
- Buffers batches in memory (capped by `--clickhouse-max-buffer`)
- Applies schema at startup (`CREATE TABLE IF NOT EXISTS…`)
- Survives ClickHouse downtime by buffering; resync on reconnect

---

## Data Flow: From Kernel to User

```
┌─────────────────────────────────────────────────────────────────────┐
│ KERNEL                                                              │
│                                                                     │
│  tcp_sendmsg() ─fexit─┐                                             │
│  tcp_cleanup_rbuf()   │                                             │
│  udp*_sendmsg()    ┌──┼─→ FlowKey + atomic add to FLOWS_A/FLOWS_B  │
│  udp*_recvmsg()    │  │    (per-flow counters)                     │
│                    └──┘                                             │
│  sched_process_exit() ─tp_btf─→ ExitEvent → ring buffer           │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
                    [sleep 2 ms, let in-flight finish]
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ USERSPACE                                                           │
│                                                                     │
│  drain() → read FlowKey+FlowStats from idle map                    │
│         → read ExitEvent ring buffer                               │
│         → read DROPS counter                                        │
│                              ↓                                       │
│  Aggregator::ingest()                                              │
│    - Group flows by (pid, start_ns)                                │
│    - Look up /proc/cmdline (process name)                          │
│    - Read /proc/stat (exec time, state)                            │
│    - Sniff TCP payload → classify app protocol                     │
│    - Compute rates from counters                                    │
│    - Handle process exits                                          │
│                              ↓                                       │
│  publish(tick)                                                     │
│    - Redis: MULTI/EXEC snapshot + stream                           │
│    - ClickHouse: batch insert (flows table + processes table)     │
│                              ↓                                       │
└─────────────────────────────────────────────────────────────────────┘
              Results available to clients (dashboard, scripts)
```

---

## Data Models

### Redis Schema (Realtime)

```
netwatch:snapshot  (string, JSON)
  {
    ts_ms: 1695230847123,
    interval_ms: 1000,
    drops: 0,
    processes: [
      {
        pid: 1234,
        start_ns: 849372948234,
        name: "firefox",
        cmdline: "/usr/bin/firefox --profile /home/user/.mozilla/firefox/…",
        uid: 1000,
        tx_kbps: 234.5,
        rx_kbps: 567.8,
        tx_total: 123456789,
        rx_total: 987654321,
        flow_count: 12,
        alive: true,
        ended_ms: null
      },
      …
    ],
    flows: [
      {
        pid: 1234,
        name: "firefox",
        raddr: "142.251.32.100",     // Plain IPv4 (not IPv6-mapped)
        rport: 443,
        lport: 54234,
        proto: "TCP",
        app: "HTTPS",
        tx_bytes: 5000,
        rx_bytes: 12000,
        tx_kbps: 5.0,
        rx_kbps: 12.0
      },
      …
    ]
  }

netwatch:proc:{pid}:{start_ns}  (hash)
  name → "firefox"
  cmdline → "/usr/bin/firefox …"
  uid → "1000"
  pid → "1234"
  start_ms → "1695230300000"
  first_seen_ms → "1695230310000"
  last_seen_ms → "1695230845000"
  alive → "1"
  ended_ms → null
  tx_kbps → "234.5"
  rx_kbps → "567.8"
  tx_total → "123456789"
  rx_total → "987654321"

netwatch:proc:{pid}:{start_ns}:dests  (hash)
  "TCP|HTTPS|142.251.32.100|443" → '{"tx_total":5000,"rx_total":12000}'
  "TCP|DNS|8.8.8.8|53" → '{"tx_total":345,"rx_total":234}'
  …

netwatch:alive  (set)
  "1234:849372948234"
  "5678:849371234567"
  …

netwatch:ended  (sorted set, score = end time ms)
  "1200:849360000000" score 1695229900000
  …
```

### ClickHouse Schema (History)

```sql
-- netwatch.flows: one row per (process, remote endpoint, local port) per interval
CREATE TABLE netwatch.flows (
  ts DateTime64(3),              -- Collection tick time
  interval_ms UInt32,             -- Tick interval
  pid UInt32,
  proc_start UInt64,              -- Process start time in ns (with pid, identifies instance)
  name LowCardinality(String),    -- Process name
  uid UInt32,
  proto LowCardinality(String),   -- "TCP" or "UDP"
  app LowCardinality(String),     -- "HTTPS", "SSH", "DNS", "unknown", …
  raddr IPv6,                     -- Remote address (IPv4 as ::ffff:a.b.c.d)
  rport UInt16,
  lport UInt16,
  tx_bytes UInt64,
  rx_bytes UInt64,
  tx_calls UInt32,
  rx_calls UInt32,
  …
) ENGINE = MergeTree
  PARTITION BY toDate(ts)
  ORDER BY (pid, proc_start, ts)
  TTL toDateTime(ts) + INTERVAL 90 DAY;

-- Rollup: one row per minute per (process, remote, proto, app)
-- Filled by a materialized view over `flows`
CREATE TABLE netwatch.flows_1m { … }
ENGINE = SummingMergeTree

-- netwatch.processes: latest state of every process instance
CREATE TABLE netwatch.processes (
  pid UInt32,
  proc_start UInt64,
  start_ms DateTime64(3),         -- Exec time
  name LowCardinality(String),
  cmdline String,
  uid UInt32,
  first_seen DateTime64(3),       -- First network I/O
  last_seen DateTime64(3),        -- Last network I/O
  ended Nullable(DateTime64(3)),  -- Exit time (null if still running)
  tx_total UInt64,
  rx_total UInt64,
  version UInt64                  -- ReplacingMergeTree versioning
) ENGINE = ReplacingMergeTree(version)
  ORDER BY (pid, proc_start);
```

---

## Measurement Methodology

### What Is Counted

**Application payload only**:
- Bytes passed to/from socket syscalls (send, recv, sendmsg, recvmsg, etc.)
- **Excludes**: IP headers, TCP headers, retransmits, ACKs
- **Why**: This is what users care about ("How much did my app use?")

**Coverage**:
- TCP send/receive (all variants: send, sendfile, io_uring)
- UDP send/receive (v4 and v6)
- QUIC (runs on UDP)
- **Not**: raw sockets, SCTP, ICMP ping, packets routed/NATed by the kernel

**Transport**:
- TCP and UDP only
- Port-based classification or payload sniffing for application protocol

### What Is Not Counted

- Kernel-originated traffic (forwarding, NAT, bridges)
- Packets retransmitted due to loss
- TCP/IP headers
- Traffic inside containers shows the host PID (container traffic is attributed to the process that created the container)

### Measurement Accuracy Issues

**Interval boundaries**: After switching maps, the collector waits 2 ms before draining. Any syscall still in progress will land its bytes in the *next* drain of that map—they're *late* by one interval, not lost.

**Map capacity**: If >1M distinct flows appear in one tick, extras are counted in `DROPS` and logged. This should never happen on typical systems.

**UDP without peer info**: Unconnected UDP sockets that receive without a peer address show `0.0.0.0:0`.

---

## Process Lifecycle Tracking

A process is identified uniquely by `(tgid, start_ns)`:
- `tgid`: process group ID (what `ps` shows as PID)
- `start_ns`: boot-relative start time from `task_struct::start_boottime`

**Why not just PID?** PIDs are reused. A process tree killer that restarts Apache reuses the same PID; we'd incorrectly merge two instances' traffic.

### Transitions:

1. **First flow from a process**: 
   - `model.rs` sees a new `(tgid, start_ns)` pair
   - Reads `/proc/[tgid]/stat` (exec time, user, comm)
   - Marks `first_seen_ms = now`
   - Added to `netwatch:alive`

2. **Process exits while running**:
   - eBPF `sched_process_exit` hook fires
   - Sends `ExitEvent` via ring buffer
   - `model.rs` receives it, marks `ended_ms = now`
   - Removed from `netwatch:alive`, added to `netwatch:ended` (expires after `--ended-ttl-secs`, default 7 days)

3. **Exit race condition**:
   - Exit event may arrive before the process is first seen (kernel timing)
   - `model.rs` retries periodically (every 5 s sweep)
   - After 60 s without matching, the exit is discarded

---

## Payload Sniffing for Protocol Detection

### Priority:

1. **TCP payload sniffing** (first 8 bytes of first send per interval):
   - `0x14-0x17` + `0x03` + `0x00-0x04` at start → TLS (all versions from SSL3 to TLS 1.3)
   - `SSH-` → SSH
   - `PRI * HT` → HTTP/2 (connection preface)
   - `GET `, `POST`, `PUT `, `HEAD`, `DELETE`, `OPTIONS`, `PATCH`, `CONNECT`, `TRACE`, or `HTTP` → HTTP/1.x

2. **Fallback**: Well-known ports
   - Remote port first (prefer port over local port)
   - If unknown, try local port
   - If still unknown: `unknown`

### Result cached per flow per interval

**HTTPS**: TLS on 443/8443, or TLS on an HTTP port
**QUIC**: UDP/443
**DNS**: UDP/53, TCP/53
**FTP**: TCP/20-21
**PostgreSQL**: TCP/5432
(See `classify.rs` for full list)

---

## Configuration & Limits

### Command-Line Flags

```
--interval-ms       1000          # Aggregation interval
--cpus              62,63         # CPU affinity
--no-redis                        # Disable Redis sink
--no-clickhouse                   # Disable ClickHouse sink
--stream-maxlen     3600          # Redis stream retention (ticks)
--ended-ttl-secs    604800        # Ended process retention (days)
--no-sniff                        # Disable TCP payload sniffing
--clickhouse-max-buffer  100MB    # Max memory buffer for ClickHouse
```

### Performance Characteristics

**Kernel overhead per syscall**: 
- One hash map lookup
- Two atomic add instructions
- A few eBPF helper calls to read socket struct
- **Typical**: <1 μs per send/recv on modern hardware

**Userspace per tick** (1000 ticks/s):
- `BPF_MAP_LOOKUP_AND_DELETE_BATCH`: ~1 ms for 10k flows
- Aggregation + rate calculation: <5 ms
- Redis + ClickHouse publish: <10 ms (depends on DB latency)
- **Typical**: 1-2 cores at <5% utilization

**Memory**:
- eBPF maps: 150 MB × 2 (FLOWS_A, FLOWS_B)
- Redis: depends on process count (typically <50 MB for ~1000 processes)
- ClickHouse: storage, not memory

---

## Android Portability: What Applies, What Doesn't

### ❌ Cannot Use (Root/Privilege Required)

- **eBPF + fentry/fexit hooks**: Android prevents loading BPF programs without specific kernel modifications and SELinux policies
- **CAP_BPF + CAP_PERFMON**: Not available to apps on standard Android devices
- **BTF reading**: Most Android kernels don't expose `/sys/kernel/btf/vmlinux`
- **Direct kernel struct access**: SELinux blocks raw reads from `/proc/[pid]/mem`

### ✅ Can Adapt

- **Data structures** (`FlowKey`, `FlowStats`): useful as models for app-level flow tracking
- **Redis/ClickHouse backends**: unchanged; can be local SQLite instead
- **Aggregation and rate calculation**: fully portable
- **Process metadata from /proc**: limited but possible (`/proc/[pid]/stat`, `/proc/[pid]/cmdline`)
- **TCP payload sniffing**: could work via packet capture if permissions allow
- **State machine** (process birth/death, flow tracking): all in userspace, portable

### 🟡 Reduced Accuracy on Non-Rooted Android

- **/proc parsing** (no eBPF):
  - Can read `/proc/net/tcp`, `/proc/net/tcp6`, `/proc/net/udp`, `/proc/net/udp6` for all processes' connections
  - Cannot see traffic bytes per-call (only summary from OS APIs)
  - **Much higher CPU overhead** (scan every 1-10 s instead of inline hooks)
  - Cannot detect process exits in real-time; must poll
  - Cannot sniff payload (no socket syscall interception)

- **Android-specific limitations**:
  - Process names change (apps may run under multiple UIDs)
  - Process lifecycle is different (freeze, background suspension)
  - No /proc/cmdline access for other apps (privacy/SELinux)
  - Network stats may be limited by `NetworkStatsManager` APIs

---

## Recommended Android Approach (Plan C from earlier)

**For a non-rooted phone, build a **userspace-only stats collector**:

```
1. Poll /proc/net/tcp* every 5-10 s
   └→ Extract (saddr, sport, daddr, dport, state) for all connections
2. Map connections back to UIDs via /proc/net/tcp → /proc/[pid]/fd/socket mapping
3. For each UID, use Android's NetworkStatsManager API to get bytes transferred
4. Aggregate by process name (from PackageManager for your own UID)
5. Store locally (SQLite) or send to a remote server
```

**Trade-offs**:
- Works on any Android ≥ 6.0 (non-rooted)
- Polls instead of inline, ~5-10% CPU overhead
- Cannot see payload sniffing (can't decrypt HTTPS to detect HTTP/2, etc.)
- Cannot see call counts (only bytes)
- Lower temporal resolution (5-10 s vs. 1 s)
- Can only reliably track your own app; other apps require system integration or rooting

