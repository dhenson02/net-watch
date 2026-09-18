//! In-kernel half of net-watch.
//!
//! Hooks the socket-layer send/receive paths with fentry/fexit trampolines
//! (the cheapest attach type available) and aggregates byte counters per
//! (process, remote endpoint) directly in a hash map. Userspace never sees
//! individual packets or syscalls - it drains the aggregated map once per
//! interval, so kernel->user traffic is proportional to the number of active
//! flows, not to the traffic volume.
//!
//! Two flow maps are double-buffered: `ACTIVE[0]` selects which one the
//! programs write to. Userspace flips it, waits briefly for in-flight programs,
//! then drains the idle map with a batched lookup-and-delete.
#![no_std]
#![no_main]
// The BPF target has no `AtomicU64::fetch_add`; the intrinsic lowers to BPF_ATOMIC ADD.
#![feature(core_intrinsics)]
#![allow(internal_features)]

use core::{
    intrinsics::{atomic_xadd, AtomicOrdering},
    mem::{size_of, zeroed},
    ptr::read_unaligned,
};

use aya_ebpf::{
    bindings::{BPF_ANY, BPF_NOEXIST},
    helpers::{
        bpf_get_current_pid_tgid, bpf_get_current_uid_gid, bpf_probe_read_kernel,
        bpf_probe_read_kernel_buf, bpf_probe_read_user_buf,
        generated::{bpf_get_current_task, bpf_ktime_get_boot_ns},
    },
    macros::{btf_tracepoint, fentry, fexit, map},
    maps::{Array, HashMap, LruHashMap, PerCpuArray, RingBuf},
    programs::{BtfTracePointContext, FEntryContext, FExitContext},
    Global,
};
use net_watch_common::{
    ExitEvent, FlowKey, FlowStats, Offsets, AF_INET, AF_INET6, COMM_LEN, FLOW_MAP_ENTRIES,
    HEAD_LEN, IPPROTO_TCP, IPPROTO_UDP, SK_BLOCK,
};

#[unsafe(no_mangle)]
static OFFSETS: Global<Offsets> = Global::new(unsafe { zeroed() });

/// Index 0 holds which flow map (0 = A, 1 = B) programs currently write to.
#[map]
static ACTIVE: Array<u32> = Array::with_max_entries(1, 0);

#[map]
static FLOWS_A: HashMap<FlowKey, FlowStats> = HashMap::with_max_entries(FLOW_MAP_ENTRIES, 0);

#[map]
static FLOWS_B: HashMap<FlowKey, FlowStats> = HashMap::with_max_entries(FLOW_MAP_ENTRIES, 0);

/// tgid -> start_ns of every process seen doing network I/O, so exits of
/// processes that never touched the network are not reported.
#[map]
static PROCS: LruHashMap<u32, u64> = LruHashMap::with_max_entries(1 << 20, 0);

#[map]
static EXITS: RingBuf = RingBuf::with_byte_size(1 << 22, 0);

/// Index 0: flow inserts that failed because the active map was full.
#[map]
static DROPS: PerCpuArray<u64> = PerCpuArray::with_max_entries(1, 0);

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

/// `int tcp_sendmsg(struct sock *sk, struct msghdr *msg, size_t size)`
/// Covers send/write/sendmsg/sendfile/splice/io_uring for TCP over IPv4 and IPv6.
#[fexit(function = "tcp_sendmsg")]
pub fn tcp_sendmsg(ctx: FExitContext) -> i32 {
    let ret: i32 = ctx.arg(3);
    if ret > 0 {
        unsafe { on_sock_io(ctx.arg(0), ctx.arg(1), IPPROTO_TCP, ret as u64, 0, IoKind::TcpSend) };
    }
    0
}

/// `void tcp_cleanup_rbuf(struct sock *sk, int copied)` - called once per
/// recvmsg/read_sock with the number of bytes handed to the application.
#[fentry(function = "tcp_cleanup_rbuf")]
pub fn tcp_cleanup_rbuf(ctx: FEntryContext) -> i32 {
    let copied: i32 = ctx.arg(1);
    if copied > 0 {
        unsafe {
            on_sock_io(ctx.arg(0), core::ptr::null(), IPPROTO_TCP, 0, copied as u64, IoKind::Plain)
        };
    }
    0
}

/// `int udp_sendmsg(struct sock *sk, struct msghdr *msg, size_t len)`
#[fexit(function = "udp_sendmsg")]
pub fn udp_sendmsg(ctx: FExitContext) -> i32 {
    let ret: i32 = ctx.arg(3);
    if ret > 0 {
        // udpv6_sendmsg() forwards v4-mapped destinations here; it is counted by
        // the udpv6 hook instead, hence `V4Only`.
        unsafe { on_sock_io(ctx.arg(0), ctx.arg(1), IPPROTO_UDP, ret as u64, 0, IoKind::UdpV4Only) };
    }
    0
}

/// `int udpv6_sendmsg(struct sock *sk, struct msghdr *msg, size_t len)`
#[fexit(function = "udpv6_sendmsg")]
pub fn udpv6_sendmsg(ctx: FExitContext) -> i32 {
    let ret: i32 = ctx.arg(3);
    if ret > 0 {
        unsafe { on_sock_io(ctx.arg(0), ctx.arg(1), IPPROTO_UDP, ret as u64, 0, IoKind::Udp) };
    }
    0
}

/// `int udp_recvmsg(struct sock *sk, struct msghdr *msg, size_t len, int flags, int *addr_len)`
#[fexit(function = "udp_recvmsg")]
pub fn udp_recvmsg(ctx: FExitContext) -> i32 {
    let ret: i32 = ctx.arg(5);
    if ret > 0 {
        unsafe { on_sock_io(ctx.arg(0), ctx.arg(1), IPPROTO_UDP, 0, ret as u64, IoKind::Udp) };
    }
    0
}

/// `int udpv6_recvmsg(struct sock *sk, struct msghdr *msg, size_t len, int flags, int *addr_len)`
#[fexit(function = "udpv6_recvmsg")]
pub fn udpv6_recvmsg(ctx: FExitContext) -> i32 {
    let ret: i32 = ctx.arg(5);
    if ret > 0 {
        unsafe { on_sock_io(ctx.arg(0), ctx.arg(1), IPPROTO_UDP, 0, ret as u64, IoKind::Udp) };
    }
    0
}

/// Reports the exit of any process that previously did network I/O.
#[btf_tracepoint(function = "sched_process_exit")]
pub fn sched_process_exit(_ctx: BtfTracePointContext) -> i32 {
    let pid_tgid = bpf_get_current_pid_tgid();
    let tgid = (pid_tgid >> 32) as u32;
    // Only the thread-group leader's exit marks the end of the process.
    if tgid != pid_tgid as u32 {
        return 0;
    }
    let Some(start_ns) = (unsafe { PROCS.get(&tgid) }).copied() else {
        return 0;
    };
    let _ = PROCS.remove(&tgid);
    if let Some(mut entry) = EXITS.reserve::<ExitEvent>(0) {
        entry.write(ExitEvent {
            tgid,
            _pad: 0,
            start_ns,
            ts_ns: unsafe { bpf_ktime_get_boot_ns() },
        });
        entry.submit(0);
    }
    0
}

// ---------------------------------------------------------------------------
// Shared logic
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum IoKind {
    Plain,
    /// TCP send: `msg` may be sniffed for the application protocol.
    TcpSend,
    /// UDP: remote address may come from `msg->msg_name` on unconnected sockets.
    Udp,
    /// Like `Udp`, but skip AF_INET6 sockets (already counted by the v6 hook).
    UdpV4Only,
}

#[inline(always)]
unsafe fn on_sock_io(sk: *const u8, msg: *const u8, proto: u8, tx: u64, rx: u64, kind: IoKind) {
    let tgid = (bpf_get_current_pid_tgid() >> 32) as u32;
    let o = OFFSETS.load();
    if tgid == o.self_tgid || sk.is_null() {
        return;
    }
    let Some(mut key) = sock_key(sk, &o, proto, tgid) else {
        return;
    };
    match kind {
        IoKind::UdpV4Only if key.family == AF_INET6 as u8 => return,
        IoKind::Udp | IoKind::UdpV4Only => udp_peer_from_msg(msg, &o, &mut key),
        _ => {}
    }
    let sniff_msg = if kind == IoKind::TcpSend { msg } else { core::ptr::null() };
    account(&key, tx, rx, sniff_msg, &o);
}

/// Builds the flow key from `struct sock_common` using a single probe read.
#[inline(always)]
unsafe fn sock_key(sk: *const u8, o: &Offsets, proto: u8, tgid: u32) -> Option<FlowKey> {
    let mut blk = [0u8; SK_BLOCK];
    bpf_probe_read_kernel_buf(sk.add(o.sk_base as usize), &mut blk).ok()?;

    let family: u16 = rd(&blk, o.skc_family);
    let mut key = FlowKey {
        tgid,
        rport: u16::from_be(rd(&blk, o.skc_dport)),
        lport: rd(&blk, o.skc_num),
        raddr: [0; 16],
        family: family as u8,
        proto,
        _pad: [0; 6],
    };
    if family == AF_INET {
        set_v4(&mut key.raddr, rd(&blk, o.skc_daddr));
    } else if family == AF_INET6 {
        key.raddr = rd(&blk, o.skc_v6_daddr);
    } else {
        return None;
    }
    Some(key)
}

/// Unconnected UDP sockets have no peer in `sock_common`; the kernel keeps the
/// destination (send) or source (receive) in `msg->msg_name` instead.
#[inline(always)]
unsafe fn udp_peer_from_msg(msg: *const u8, o: &Offsets, key: &mut FlowKey) {
    if key.rport != 0 || msg.is_null() {
        return;
    }
    let Ok(name) = bpf_probe_read_kernel(msg.add(o.msghdr_name as usize) as *const *const u8)
    else {
        return;
    };
    if name.is_null() {
        return;
    }
    // Large enough for sockaddr_in6 up to and including sin6_addr.
    let mut sa = [0u8; 24];
    if bpf_probe_read_kernel_buf(name, &mut sa).is_err() {
        return;
    }
    let family = u16::from_ne_bytes([sa[0], sa[1]]);
    let port = u16::from_be_bytes([sa[2], sa[3]]);
    if family == AF_INET {
        set_v4(&mut key.raddr, [sa[4], sa[5], sa[6], sa[7]]);
        key.rport = port;
    } else if family == AF_INET6 {
        key.raddr = rd(&sa, 8);
        key.rport = port;
    }
}

#[inline(always)]
unsafe fn account(key: &FlowKey, tx: u64, rx: u64, sniff_msg: *const u8, o: &Offsets) {
    let flows = match ACTIVE.get(0) {
        Some(&1) => &FLOWS_B,
        _ => &FLOWS_A,
    };

    // Hot path: flow already present this interval -> two atomic adds.
    if let Some(v) = flows.get_ptr_mut(key) {
        add(v, tx, rx);
        return;
    }

    // First event for this flow in this interval.
    let mut st = FlowStats {
        tx_bytes: tx,
        rx_bytes: rx,
        tx_calls: (tx != 0) as u64,
        rx_calls: (rx != 0) as u64,
        start_ns: 0,
        comm: [0; COMM_LEN],
        head: [0; HEAD_LEN],
        head_len: 0,
        uid: bpf_get_current_uid_gid() as u32,
    };
    leader_info(o, &mut st);
    if !sniff_msg.is_null() && tx >= HEAD_LEN as u64 {
        sniff_head(sniff_msg, o, &mut st);
    }

    match flows.insert(key, &st, BPF_NOEXIST as u64) {
        Ok(()) => {
            let _ = PROCS.insert(&key.tgid, &st.start_ns, BPF_ANY as u64);
        }
        // Another CPU inserted it first, or the map is full.
        Err(_) => match flows.get_ptr_mut(key) {
            Some(v) => add(v, tx, rx),
            None => {
                if let Some(d) = DROPS.get_ptr_mut(0) {
                    *d += 1;
                }
            }
        },
    }
}

#[inline(always)]
unsafe fn add(v: *mut FlowStats, tx: u64, rx: u64) {
    if tx != 0 {
        atomic_xadd::<u64, u64, { AtomicOrdering::Relaxed }>(&raw mut (*v).tx_bytes, tx);
        atomic_xadd::<u64, u64, { AtomicOrdering::Relaxed }>(&raw mut (*v).tx_calls, 1);
    }
    if rx != 0 {
        atomic_xadd::<u64, u64, { AtomicOrdering::Relaxed }>(&raw mut (*v).rx_bytes, rx);
        atomic_xadd::<u64, u64, { AtomicOrdering::Relaxed }>(&raw mut (*v).rx_calls, 1);
    }
}

/// Process name and start time come from the thread-group leader so that
/// worker threads with custom names are still attributed to their process.
#[inline(always)]
unsafe fn leader_info(o: &Offsets, st: &mut FlowStats) {
    let task = bpf_get_current_task() as *const u8;
    let leader =
        bpf_probe_read_kernel(task.add(o.task_group_leader as usize) as *const *const u8)
            .unwrap_or(task);
    if let Ok(comm) = bpf_probe_read_kernel(leader.add(o.task_comm as usize) as *const [u8; COMM_LEN]) {
        st.comm = comm;
    }
    if let Ok(start) = bpf_probe_read_kernel(leader.add(o.task_start_boottime as usize) as *const u64) {
        st.start_ns = start;
    }
}

/// Copies the first bytes of the user buffer that was just sent, for protocol
/// detection in userspace. Only single-buffer sends (ITER_UBUF - what the
/// kernel uses for send/write/sendto and single-iovec sendmsg) are handled;
/// the `ubuf` pointer is left untouched by the copy, so it still points at the
/// start of the payload after the send completes.
#[inline(always)]
unsafe fn sniff_head(msg: *const u8, o: &Offsets, st: &mut FlowStats) {
    if o.sniff == 0 {
        return;
    }
    let iter = msg.add(o.msghdr_iter as usize);
    let Ok(ty) = bpf_probe_read_kernel::<u8>(iter.add(o.iter_type as usize)) else {
        return;
    };
    if ty as u32 != o.iter_ubuf_val {
        return;
    }
    let Ok(ubuf) = bpf_probe_read_kernel(iter.add(o.iter_ubuf as usize) as *const *const u8)
    else {
        return;
    };
    let mut head = [0u8; HEAD_LEN];
    if bpf_probe_read_user_buf(ubuf, &mut head).is_ok() {
        st.head = head;
        st.head_len = HEAD_LEN as u32;
    }
}

/// Bounds-checked unaligned read from a stack buffer; the check lets both
/// rustc and the verifier prove the access is in range.
#[inline(always)]
fn rd<T: Copy, const N: usize>(buf: &[u8; N], off: u32) -> T {
    let off = off as usize;
    if off + size_of::<T>() > N {
        return unsafe { zeroed() };
    }
    unsafe { read_unaligned(buf.as_ptr().add(off) as *const T) }
}

#[inline(always)]
fn set_v4(dst: &mut [u8; 16], v4: [u8; 4]) {
    dst[10] = 0xff;
    dst[11] = 0xff;
    dst[12] = v4[0];
    dst[13] = v4[1];
    dst[14] = v4[2];
    dst[15] = v4[3];
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

#[unsafe(link_section = "license")]
#[unsafe(no_mangle)]
static LICENSE: [u8; 13] = *b"Dual MIT/GPL\0";
