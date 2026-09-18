//! Loads/attaches the eBPF programs and drains their aggregated counters.

use std::{
    io,
    mem::size_of,
    os::fd::{AsFd as _, AsRawFd as _, RawFd},
    ptr::read_unaligned,
};

use anyhow::{anyhow, Context as _, Result};
use aya::{
    maps::{Array, Map, MapData, PerCpuArray, RingBuf},
    programs::{BtfTracePoint, FEntry, FExit},
    Btf as AyaBtf, Ebpf, EbpfLoader,
};

use net_watch_common::{ExitEvent, FlowKey, FlowStats, Offsets};

/// (program name in the object, kernel function to attach to)
const FEXITS: &[(&str, &str)] = &[
    ("tcp_sendmsg", "tcp_sendmsg"),
    ("udp_sendmsg", "udp_sendmsg"),
    ("udpv6_sendmsg", "udpv6_sendmsg"),
    ("udp_recvmsg", "udp_recvmsg"),
    ("udpv6_recvmsg", "udpv6_recvmsg"),
];
const FENTRIES: &[(&str, &str)] = &[("tcp_cleanup_rbuf", "tcp_cleanup_rbuf")];

/// Elements fetched per BPF_MAP_LOOKUP_AND_DELETE_BATCH syscall.
const BATCH: usize = 16 * 1024;

pub struct Probe {
    // Keeps programs and links alive.
    _ebpf: Ebpf,
    flows: [MapData; 2],
    active: Array<MapData, u32>,
    exits: RingBuf<MapData>,
    drops: PerCpuArray<MapData, u64>,
    cur: u32,
    keys: Vec<FlowKey>,
    vals: Vec<FlowStats>,
}

impl Probe {
    pub fn load(offsets: &Offsets) -> Result<Self> {
        let obj = aya::include_bytes_aligned!(concat!(env!("OUT_DIR"), "/net-watch"));
        let mut ebpf = EbpfLoader::new()
            .override_global("OFFSETS", offsets, true)
            .load(obj)
            .context("loading eBPF object (are you root / CAP_BPF+CAP_PERFMON?)")?;

        let btf = AyaBtf::from_sys_fs().context("loading kernel BTF")?;
        for (prog, func) in FEXITS {
            let p: &mut FExit = program(&mut ebpf, prog)?.try_into()?;
            p.load(func, &btf).with_context(|| format!("loading fexit/{func}"))?;
            p.attach().with_context(|| format!("attaching fexit/{func}"))?;
        }
        for (prog, func) in FENTRIES {
            let p: &mut FEntry = program(&mut ebpf, prog)?.try_into()?;
            p.load(func, &btf).with_context(|| format!("loading fentry/{func}"))?;
            p.attach().with_context(|| format!("attaching fentry/{func}"))?;
        }
        let p: &mut BtfTracePoint = program(&mut ebpf, "sched_process_exit")?.try_into()?;
        p.load("sched_process_exit", &btf).context("loading tp_btf/sched_process_exit")?;
        p.attach().context("attaching tp_btf/sched_process_exit")?;

        let flows = [take_hash(&mut ebpf, "FLOWS_A")?, take_hash(&mut ebpf, "FLOWS_B")?];
        let active = Array::try_from(take(&mut ebpf, "ACTIVE")?)?;
        let exits = RingBuf::try_from(take(&mut ebpf, "EXITS")?)?;
        let drops = PerCpuArray::try_from(take(&mut ebpf, "DROPS")?)?;

        Ok(Self {
            _ebpf: ebpf,
            flows,
            active,
            exits,
            drops,
            cur: 0,
            keys: vec![unsafe { std::mem::zeroed() }; BATCH],
            vals: vec![unsafe { std::mem::zeroed() }; BATCH],
        })
    }

    /// Redirects the programs to the other flow map and returns the index of
    /// the one they were writing to, which is now idle and ready to drain.
    pub fn flip(&mut self) -> Result<usize> {
        let prev = self.cur;
        self.cur ^= 1;
        self.active.set(0, self.cur, 0)?;
        Ok(prev as usize)
    }

    /// Moves every entry of flow map `idx` into `out`, deleting it from the
    /// kernel map, using as few syscalls as possible.
    pub fn drain(&mut self, idx: usize, out: &mut Vec<(FlowKey, FlowStats)>) -> Result<()> {
        let fd = self.flows[idx].fd().as_fd().as_raw_fd();
        let mut in_batch: u32 = 0;
        let mut out_batch: u32 = 0;
        let mut first = true;
        loop {
            let (n, done) = lookup_and_delete_batch(
                fd,
                if first { None } else { Some(&in_batch) },
                &mut out_batch,
                &mut self.keys,
                &mut self.vals,
            )?;
            out.extend(self.keys[..n].iter().copied().zip(self.vals[..n].iter().copied()));
            if done {
                return Ok(());
            }
            in_batch = out_batch;
            first = false;
        }
    }

    pub fn drain_exits(&mut self, out: &mut Vec<ExitEvent>) {
        while let Some(item) = self.exits.next() {
            if item.len() >= size_of::<ExitEvent>() {
                out.push(unsafe { read_unaligned(item.as_ptr() as *const ExitEvent) });
            }
        }
    }

    /// Total flow inserts dropped because a map was full, since start.
    pub fn drops(&self) -> u64 {
        self.drops.get(&0, 0).map(|v| v.iter().sum()).unwrap_or(0)
    }
}

fn program<'a>(ebpf: &'a mut Ebpf, name: &str) -> Result<&'a mut aya::programs::Program> {
    ebpf.program_mut(name).ok_or_else(|| anyhow!("program {name} missing from object"))
}

fn take(ebpf: &mut Ebpf, name: &str) -> Result<Map> {
    ebpf.take_map(name).ok_or_else(|| anyhow!("map {name} missing from object"))
}

fn take_hash(ebpf: &mut Ebpf, name: &str) -> Result<MapData> {
    match take(ebpf, name)? {
        Map::HashMap(data) => Ok(data),
        _ => Err(anyhow!("map {name} is not a BPF_MAP_TYPE_HASH")),
    }
}

/// `union bpf_attr` layout for the BPF_MAP_*_BATCH commands.
#[repr(C)]
#[derive(Default)]
struct BatchAttr {
    in_batch: u64,
    out_batch: u64,
    keys: u64,
    values: u64,
    count: u32,
    map_fd: u32,
    elem_flags: u64,
    flags: u64,
}

const BPF_MAP_LOOKUP_AND_DELETE_BATCH: libc::c_long = 25;

/// Returns (entries fetched, whether the map has been fully traversed).
fn lookup_and_delete_batch(
    fd: RawFd,
    in_batch: Option<&u32>,
    out_batch: &mut u32,
    keys: &mut [FlowKey],
    vals: &mut [FlowStats],
) -> Result<(usize, bool)> {
    let mut attr = BatchAttr {
        in_batch: in_batch.map_or(0, |b| b as *const u32 as u64),
        out_batch: out_batch as *mut u32 as u64,
        keys: keys.as_mut_ptr() as u64,
        values: vals.as_mut_ptr() as u64,
        count: keys.len().min(vals.len()) as u32,
        map_fd: fd as u32,
        ..Default::default()
    };
    let ret = unsafe {
        libc::syscall(
            libc::SYS_bpf,
            BPF_MAP_LOOKUP_AND_DELETE_BATCH,
            &mut attr as *mut BatchAttr,
            size_of::<BatchAttr>() as u32,
        )
    };
    if ret == 0 {
        return Ok((attr.count as usize, false));
    }
    let err = io::Error::last_os_error();
    match err.raw_os_error() {
        // ENOENT marks the end of the traversal; `count` still holds the final chunk.
        Some(libc::ENOENT) => Ok((attr.count as usize, true)),
        _ => Err(anyhow!(err).context("BPF_MAP_LOOKUP_AND_DELETE_BATCH")),
    }
}
