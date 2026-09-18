//! Types shared between the eBPF programs and the userspace collector.
//!
//! Every struct here is `#[repr(C)]` with explicit padding so the byte layout
//! is identical on both sides and the verifier never sees uninitialised stack.
#![no_std]

pub const AF_INET: u16 = 2;
pub const AF_INET6: u16 = 10;
pub const IPPROTO_TCP: u8 = 6;
pub const IPPROTO_UDP: u8 = 17;

pub const COMM_LEN: usize = 16;
/// Number of payload bytes sniffed from the first TCP send of a flow per interval.
pub const HEAD_LEN: usize = 8;
/// Bytes read from `struct sock` in one helper call (see `Offsets::sk_base`).
pub const SK_BLOCK: usize = 80;
/// Max entries of each of the two double-buffered flow maps.
pub const FLOW_MAP_ENTRIES: u32 = 1 << 20;

/// Aggregation key: one entry per (process, transport, remote endpoint, local port).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FlowKey {
    pub tgid: u32,
    /// Remote port, host byte order.
    pub rport: u16,
    /// Local port, host byte order.
    pub lport: u16,
    /// Remote address. IPv4 is stored IPv4-mapped (`::ffff:a.b.c.d`).
    pub raddr: [u8; 16],
    /// `AF_INET` or `AF_INET6` of the socket.
    pub family: u8,
    pub proto: u8,
    pub _pad: [u8; 6],
}

/// Counters accumulated in-kernel for one `FlowKey` during one interval.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct FlowStats {
    pub tx_bytes: u64,
    pub rx_bytes: u64,
    pub tx_calls: u64,
    pub rx_calls: u64,
    /// `task_struct::start_boottime` of the thread-group leader; with `tgid`
    /// this uniquely identifies a process instance even across PID reuse.
    pub start_ns: u64,
    /// Thread-group leader's `comm` (the process name).
    pub comm: [u8; COMM_LEN],
    /// First bytes of the first TCP payload sent in this interval (protocol sniffing).
    pub head: [u8; HEAD_LEN],
    pub head_len: u32,
    pub uid: u32,
}

/// Emitted through the ring buffer when a process that had network activity exits.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ExitEvent {
    pub tgid: u32,
    pub _pad: u32,
    pub start_ns: u64,
    /// `bpf_ktime_get_boot_ns()` at exit.
    pub ts_ns: u64,
}

/// Kernel struct offsets resolved from `/sys/kernel/btf/vmlinux` at startup and
/// written into the eBPF program's read-only data before load. This avoids
/// hard-coding layouts, so the programs keep working across kernel upgrades.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Offsets {
    /// Offset within `struct sock` where the `SK_BLOCK`-byte read starts.
    pub sk_base: u32,
    /// The following are relative to `sk_base`.
    pub skc_daddr: u32,
    pub skc_dport: u32,
    pub skc_num: u32,
    pub skc_family: u32,
    pub skc_v6_daddr: u32,

    pub task_group_leader: u32,
    pub task_comm: u32,
    pub task_start_boottime: u32,

    pub msghdr_name: u32,
    pub msghdr_iter: u32,
    /// Relative to the start of `struct iov_iter`.
    pub iter_type: u32,
    pub iter_ubuf: u32,
    /// Value of `enum iter_type::ITER_UBUF`.
    pub iter_ubuf_val: u32,

    /// Our own tgid, so the collector's DB traffic is not counted.
    pub self_tgid: u32,
    /// Non-zero enables TCP payload sniffing.
    pub sniff: u32,
}

#[cfg(feature = "user")]
mod user {
    use super::*;
    unsafe impl aya::Pod for FlowKey {}
    unsafe impl aya::Pod for FlowStats {}
    unsafe impl aya::Pod for ExitEvent {}
    unsafe impl aya::Pod for Offsets {}
}
